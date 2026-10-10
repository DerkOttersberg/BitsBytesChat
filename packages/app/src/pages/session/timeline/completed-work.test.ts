import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import type { Part, ToolPart } from "@opencode-ai/sdk/v2"
import { normalizeSessionMessages } from "@/utils/session-message"
import { completedWork } from "./completed-work"
import { TimelineRow } from "./timeline-row"

function fixture(suffix = "") {
  const userMessageID = `user${suffix}`
  const source = [
    { id: "user", type: "user", text: "Build the mod", time: { created: 1000 } },
    {
      id: "progress",
      type: "assistant",
      agent: "build",
      model: { id: "fixture", providerID: "fixture" },
      content: [{ type: "text", text: "I will build it." }],
      time: { created: 2000, completed: 3000 },
      finish: "tool-calls",
    },
    {
      id: "answer",
      type: "assistant",
      agent: "build",
      model: { id: "fixture", providerID: "fixture" },
      content: [
        { type: "text", text: "Built the mod." },
        { type: "text", text: "Use this JAR." },
      ],
      time: { created: 4000, completed: 61000 },
      finish: "stop",
    },
  ] satisfies SessionMessageInfo[]
  source.forEach((message) => {
    message.id += suffix
  })
  const normalized = normalizeSessionMessages("session", source)
  const rows = [
    new TimelineRow.UserMessage({ userMessageID, anchor: true }),
    ...source
      .filter((message) => message.type === "assistant")
      .flatMap((message) =>
        (normalized.parts.get(message.id) ?? []).map(
          (part) =>
            new TimelineRow.AssistantPart({
              userMessageID,
              previousAssistantPart: true,
              group: { key: part.id, type: "part", ref: { messageID: message.id, partID: part.id } },
            }),
        ),
      ),
  ]
  return {
    rows,
    messages: new Map(normalized.messages.map((message) => [message.id, message])),
    parts: (id: string) => normalized.parts.get(id) ?? [],
    status: "idle" as const,
    activeMessageID: userMessageID,
    expanded: {} as Record<string, boolean | undefined>,
  }
}

test("completed work defaults collapsed and preserves every final text part", () => {
  const input = fixture()
  const rows = completedWork(input)
  expect(rows.map((row) => row._tag)).toEqual(["UserMessage", "WorkSummary", "AssistantPart", "AssistantPart"])
  expect(rows[1]).toMatchObject({ count: 1, elapsedMs: 60000, expanded: false, failures: 0 })
  expect(input.rows).toHaveLength(4)
})

test("expansion preserves original order and row identity", () => {
  const input = fixture()
  const rows = completedWork({ ...input, expanded: { "work:user": true } })
  expect(rows).toHaveLength(5)
  expect(rows[2]).toBe(input.rows[1])
  expect(rows.at(-1)).toBe(input.rows.at(-1))
})

test.each(["busy", "retry"] as const)("%s work stays visible", (status) => {
  const input = fixture()
  expect(completedWork({ ...input, status })).toEqual(input.rows)
})

test("a terminal error and an unfinished final message remain visible", () => {
  const input = fixture()
  const answer = input.messages.get("answer")!
  if (answer.role !== "assistant") throw Error("fixture")
  answer.error = { name: "UnknownError", data: { message: "Connection failed" } }
  expect(completedWork(input)).toEqual(input.rows)
  answer.error = undefined
  answer.time.completed = undefined
  expect(completedWork(input)).toEqual(input.rows)
})

test("a final tool-call round is not presented as a completed answer", () => {
  const input = fixture()
  const answer = input.messages.get("answer")!
  if (answer.role !== "assistant") throw Error("fixture")
  answer.finish = "tool-calls"
  expect(completedWork(input)).toEqual(input.rows)
})

test("unsuccessful attempts stay available without inventing recovery", () => {
  const input = fixture()
  const failed: ToolPart = {
    id: "fetch",
    sessionID: "session",
    messageID: "progress",
    callID: "fetch",
    type: "tool",
    tool: "webfetch",
    state: {
      status: "error",
      input: { url: "https://example.org/missing" },
      error: "HTTP 404",
      time: { start: 2, end: 3 },
    },
  }
  const original = input.parts
  input.parts = (id) => (id === "progress" ? [...original(id), failed] : original(id))
  input.rows.splice(
    2,
    0,
    new TimelineRow.AssistantPart({
      userMessageID: "user",
      previousAssistantPart: true,
      group: { key: "fetch", type: "part", ref: { messageID: "progress", partID: "fetch" } },
    }),
  )
  const rows = completedWork(input)
  expect(rows.find((row) => row._tag === "WorkSummary")).toMatchObject({ failures: 1 })
  expect(completedWork({ ...input, expanded: { "work:user": true } })).toContain(input.rows[2]!)
})

test("inline image reads and questions remain outside folded work", () => {
  const input = fixture()
  const protectedParts: Part[] = [
    {
      id: "question",
      sessionID: "session",
      messageID: "progress",
      callID: "question",
      type: "tool",
      tool: "question",
      state: {
        status: "completed",
        input: {},
        output: "answered",
        title: "question",
        metadata: {},
        time: { start: 2, end: 3 },
      },
    },
    {
      id: "image",
      sessionID: "session",
      messageID: "progress",
      callID: "image",
      type: "tool",
      tool: "read",
      state: {
        status: "completed",
        input: {},
        output: "image",
        title: "image",
        metadata: {},
        time: { start: 2, end: 3 },
        attachments: [
          {
            id: "attachment",
            sessionID: "session",
            messageID: "progress",
            type: "file",
            mime: "image/png",
            url: "data:image/png;base64,aGVsbG8=",
          },
        ],
      },
    },
  ]
  const original = input.parts
  input.parts = (id) => (id === "progress" ? [...original(id), ...protectedParts] : original(id))
  const rows = protectedParts.map(
    (part) =>
      new TimelineRow.AssistantPart({
        userMessageID: "user",
        previousAssistantPart: true,
        group: { key: part.id, type: "part", ref: { messageID: "progress", partID: part.id } },
      }),
  )
  input.rows.splice(2, 0, ...rows)
  expect(completedWork(input)).toContain(rows[0]!)
  expect(completedWork(input)).toContain(rows[1]!)
})

test("turn expansion is independent and a newer active turn does not unfold completed history", () => {
  const first = fixture()
  const second = fixture("2")
  const input = {
    ...first,
    rows: [...first.rows, ...second.rows],
    messages: new Map([...first.messages, ...second.messages]),
    parts: (id: string) => [...first.parts(id), ...second.parts(id)],
    activeMessageID: "user2",
  }
  const busy = completedWork({ ...input, status: "busy" })
  expect(busy.filter((row) => row._tag === "WorkSummary")).toHaveLength(1)
  expect(busy).toContain(second.rows[1]!)
  const expanded = completedWork({ ...input, expanded: { "work:user": true } })
  expect(expanded.filter((row) => row._tag === "WorkSummary").map((row) => row.expanded)).toEqual([true, false])
  expect(expanded).toContain(first.rows[1]!)
  expect(expanded).not.toContain(second.rows[1]!)
})

test("pending tools, retry rows, task errors and image generation cannot disappear into completed work", () => {
  const input = fixture()
  const pending: ToolPart = {
    id: "pending",
    sessionID: "session",
    messageID: "answer",
    callID: "pending",
    type: "tool",
    tool: "read",
    state: { status: "pending", input: {}, raw: "" },
  }
  const original = input.parts
  expect(
    completedWork({ ...input, parts: (id) => (id === "answer" ? [...original(id), pending] : original(id)) }),
  ).toEqual(input.rows)
  const error = new TimelineRow.Error({ userMessageID: "user", text: "Task failed" })
  expect(completedWork({ ...input, rows: [...input.rows, error] })).toEqual([...input.rows, error])
  const retry = new TimelineRow.Retry({ userMessageID: "user" })
  expect(completedWork({ ...input, rows: [...input.rows, retry] })).toEqual([...input.rows, retry])
  const image: ToolPart = { ...pending, id: "generated", messageID: "progress", tool: "bitsbytes-local_generate_image" }
  const imageRow = new TimelineRow.AssistantPart({
    userMessageID: "user",
    previousAssistantPart: true,
    group: { key: "generated", type: "part", ref: { messageID: "progress", partID: "generated" } },
  })
  expect(
    completedWork({
      ...input,
      rows: [...input.rows, imageRow],
      parts: (id) => (id === "progress" ? [...original(id), image] : original(id)),
    }),
  ).toContain(imageRow)
})
