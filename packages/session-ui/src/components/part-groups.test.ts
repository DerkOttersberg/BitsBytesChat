import { expect, test } from "bun:test"
import type { Part, ToolPart } from "@opencode-ai/sdk/v2"
import { groupParts, sameGroups } from "./part-groups"

function tool(id: string, name = "read", status: "completed" | "running" | "error" = "completed"): ToolPart {
  const base = { id, sessionID: "chat", messageID: "assistant", type: "tool" as const, callID: id, tool: name }
  if (status === "error")
    return { ...base, state: { status, input: {}, error: "Unresolved failure", time: { start: 1, end: 2 } } }
  if (status === "running") return { ...base, state: { status, input: {}, time: { start: 1 } } }
  return { ...base, state: { status, input: {}, output: "", title: name, metadata: {}, time: { start: 1, end: 2 } } }
}
const rows = (...parts: Part[]) => parts.map((part) => ({ messageID: part.messageID, part }))
const text: Part = {
  id: "commentary",
  sessionID: "chat",
  messageID: "assistant",
  type: "text",
  text: "Progress update",
}
const reasoning: Part = { ...text, id: "reasoning", type: "reasoning", time: { start: 1, end: 2 } }

test("commentary and reasoning retain their position between consecutive activity groups", () => {
  const grouped = groupParts(
    rows(tool("read"), tool("edit", "edit"), text, tool("command", "shell"), reasoning, tool("web", "webfetch")),
  )
  expect(grouped.map((group) => group.type)).toEqual(["context", "part", "context", "part", "context"])
  expect(grouped[0]).toEqual({
    key: "context:read",
    type: "context",
    refs: [
      { messageID: "assistant", partID: "read" },
      { messageID: "assistant", partID: "edit" },
    ],
  })
  expect(grouped[1]).toMatchObject({ ref: { partID: "commentary" } })
  expect(grouped[3]).toMatchObject({ ref: { partID: "reasoning" } })
})

test("appending tool results preserves group identity while updating membership", () => {
  const before = groupParts(rows(tool("first", "shell", "running")))
  const completed = groupParts(rows(tool("first", "shell")))
  const appended = groupParts(rows(tool("first", "shell"), tool("next", "read")))
  expect(sameGroups(before, completed)).toBe(true)
  expect(before[0]?.key).toBe(appended[0]?.key)
  expect(sameGroups(before, appended)).toBe(false)
  expect(sameGroups(undefined, appended)).toBe(false)
})

test("unknown tools, questions, failed operations and image snapshots are never swallowed", () => {
  const image = tool("image")
  if (image.state.status !== "completed") throw Error("fixture state")
  image.state.attachments = [
    {
      id: "snapshot",
      sessionID: "chat",
      messageID: "assistant",
      type: "file",
      mime: "image/png",
      url: "data:image/png;base64,aGVsbG8=",
    },
  ]
  const grouped = groupParts(
    rows(
      tool("first"),
      tool("unknown", "private_mcp"),
      tool("question", "question"),
      tool("failure", "shell", "error"),
      image,
      tool("last"),
    ),
  )
  expect(grouped.map((group) => group.type)).toEqual(["context", "part", "part", "part", "part", "context"])
})

test("verified retries retain recovery provenance rather than entering routine collapsed activity", () => {
  const failure = tool("first", "edit", "error")
  const success = tool("retry", "edit")
  if (failure.state.status !== "error" || success.state.status !== "completed") throw Error("fixture states")
  const operation = { operationID: "op", sessionID: "chat", tool: "edit", outputKey: "output" }
  failure.state.metadata = { "bitsbytes.operation": { ...operation, attemptID: "first" } }
  success.state.metadata = {
    "bitsbytes.operation": {
      ...operation,
      attemptID: "retry",
      retryOf: "first",
      artifacts: [{ id: "artifact", revision: 2, hash: "verified" }],
    },
  }
  expect(groupParts(rows(failure, success))).toEqual([
    {
      key: "part:assistant:retry",
      type: "part",
      ref: { messageID: "assistant", partID: "retry" },
      recovered: [{ messageID: "assistant", partID: "first" }],
    },
  ])
})
