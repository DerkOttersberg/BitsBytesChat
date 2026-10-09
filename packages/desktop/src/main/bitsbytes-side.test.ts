import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BBSide } from "./bitsbytes-side"
import { BBRuns, type RunPrompt } from "./bitsbytes-runs"

type Child = {
  id: string
  parentID: string
  metadata?: { bitsbytesDiagnostic?: { key: string; parentID: string; ownerID: string } }
  diagnostic?: { key: string; parentID: string; ownerID: string }
  time?: { archived?: number }
}
const fixtures: { folder: string; server: ReturnType<typeof Bun.serve>; runs: BBRuns }[] = []
async function fixture(protocol: "v1" | "v2" = "v1") {
  const folder = await mkdtemp(join(tmpdir(), "bb-side-test-"))
  const children: Child[] = [{ id: "ses_historical", parentID: "ses_parent" }]
  const calls: string[] = []
  const state = {
    phase: "busy",
    output: "First verified output",
    posts: 0,
    loseReply: false,
    failCreate: false,
    messages: undefined as
      | {
          info: { id: string; role: string; parentID?: string }
          parts: {
            type: string
            text?: string
            synthetic?: boolean
            filename?: string
            tool?: string
            state?: { status: string; title?: string; output?: string }
          }[]
        }[]
      | undefined,
  }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname
      calls.push(request.method + " " + path)
      if (protocol === "v2") {
        if (path === "/api/session/active")
          return Response.json({
            data:
              state.phase === "busy"
                ? {
                    ses_parent: {
                      type: "running",
                      owner: { inputID: "msg_v2_input", assistantID: "msg_v2_assistant" },
                    },
                  }
                : {},
          })
        if (path.endsWith("/question") || path.endsWith("/permission")) return Response.json({ data: [] })
        if (path.endsWith("/message"))
          return Response.json({
            data: (state.messages ?? []).toReversed().map((row) => ({
              id: row.info.id,
              type: row.info.role,
              ...(row.info.role === "user"
                ? {
                    text: row.parts
                      .filter((part) => part.type === "text")
                      .map((part) => part.text)
                      .join("\n"),
                    files: [],
                  }
                : {
                    content: row.parts.map((part) => ({
                      type: part.type,
                      text: part.text,
                      name: part.tool,
                      state: part.state
                        ? {
                            status: part.state.status,
                            structured: { title: part.state.title },
                            content: [{ type: "text", text: part.state.output }],
                          }
                        : undefined,
                    })),
                  }),
            })),
          })
        if (request.method === "POST" && path === "/api/session") {
          if (state.failCreate) return new Response("Not created", { status: 503 })
          const payload = (await request.json()) as { id: string; diagnostic: NonNullable<Child["diagnostic"]> }
          state.posts++
          const child: Child = { id: payload.id, parentID: payload.diagnostic.parentID, diagnostic: payload.diagnostic }
          children.push(child)
          if (state.loseReply) {
            state.loseReply = false
            return new Response("Lost acknowledgement", { status: 503 })
          }
          return Response.json({ data: child })
        }
        if (path.endsWith("/children")) return Response.json({ data: children })
        const child = children.find(
          (row) => path === "/api/session/" + row.id || path === "/api/organization/chats/" + row.id,
        )
        if (child && request.method === "PATCH") child.time = { archived: Date.now() }
        if (path.endsWith("/interrupt") && children.some((row) => path === "/api/session/" + row.id + "/interrupt"))
          return new Response(null, { status: 204 })
        return child ? Response.json({ data: child }) : new Response("Missing", { status: 404 })
      }
      if (path === "/session/status") return Response.json({ ses_parent: { type: state.phase } })
      if (path === "/question" || path === "/permission") return Response.json([])
      if (path.endsWith("/message"))
        return Response.json(
          state.messages ?? [
            {
              info: { id: "msg_parent", role: "assistant" },
              parts: [{ type: "tool", tool: "read", state: { status: "completed", output: state.output } }],
            },
          ],
        )
      if (path.endsWith("/children")) return Response.json(children)
      if (request.method === "POST" && path === "/session") {
        const payload = (await request.json()) as Omit<Child, "id">
        const child = { ...payload, id: "ses_side_" + ++state.posts }
        children.push(child)
        if (state.loseReply) {
          state.loseReply = false
          return new Response("Lost acknowledgement", { status: 503 })
        }
        return Response.json(child)
      }
      const child = children.find((row) => path === "/session/" + row.id)
      if (child && request.method === "PATCH") Object.assign(child, await request.json())
      return child ? Response.json(child) : new Response("Missing", { status: 404 })
    },
  })
  const runs = new BBRuns(
    folder,
    async () => ({ busy: false, messages: [] }),
    async () => {
      throw Error("Side recovery cannot execute the parent")
    },
    () => undefined,
  )
  await runs.start()
  runs.close()
  fixtures.push({ folder, server, runs })
  const request = async <T>(path: string, options?: RequestInit) => {
    const response = await fetch(server.url + path, options)
    if (!response.ok) throw Object.assign(Error("HTTP " + response.status), { status: response.status })
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
  }
  return { folder, server, runs, children, calls, state, request, side: new BBSide(folder, request, runs) }
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.server.stop(true)
    fixture.runs.close()
    const folder = resolve(fixture.folder)
    if (!folder.startsWith(join(resolve(tmpdir()), "bb-side-test-"))) throw Error("Unexpected cleanup path")
    await rm(folder, { recursive: true, force: true })
  }
})

test("explicit side opens create independent owned siblings and grant only read tools", async () => {
  const f = await fixture()
  const [first, second] = await Promise.all([
    f.side.open("ses_parent", "ses_owner", f.folder, "Side"),
    f.side.open("ses_parent", "ses_owner", f.folder, "Side"),
  ])
  expect(first.id).not.toBe(second.id)
  expect(f.state.posts).toBe(2)
  expect(first.metadata?.bitsbytesDiagnostic?.key).not.toBe(second.metadata?.bitsbytesDiagnostic?.key)
  expect(first).toMatchObject({
    parentID: "ses_parent",
    permission: [
      { permission: "*", action: "deny" },
      { permission: "read", action: "allow" },
      { permission: "glob", action: "allow" },
      { permission: "grep", action: "allow" },
      { permission: "parent_progress", action: "allow" },
    ],
  })
  const journal = JSON.parse(await readFile(join(f.folder, "side-chats.json"), "utf8"))
  expect(journal).toHaveLength(2)
  expect(journal.map((row: { childID: string }) => row.childID).sort()).toEqual([first.id, second.id].sort())
  expect(journal.every((row: { state: string }) => row.state === "open")).toBe(true)
})

test("each side input gets a fresh bounded parent snapshot while an exact retry stays frozen", async () => {
  const f = await fixture(),
    child = await f.side.open("ses_parent", "ses_owner", f.folder, "Side")
  const prompt = { sessionID: child.id, directory: f.folder, id: "msg_side", text: "What is taking so long?" }
  const first = await f.side.prepare(prompt)
  expect(JSON.stringify(first.legacyParts)).toContain("First verified output")
  f.state.output = "Second verified output".repeat(10000)
  expect(await f.side.prepare(first)).toEqual(first)
  const fresh = await f.side.prepare({ ...prompt, id: "msg_side_next" })
  expect(JSON.stringify(fresh.legacyParts)).toContain("Second verified output")
  expect(JSON.stringify(fresh.legacyParts).length).toBeLessThan(12000)
  expect(first.text).toBe(prompt.text)
  await expect(f.side.prepare({ ...prompt, goal: true })).rejects.toThrow("sideReadOnly")
})

test("raw side admission retries retain journalled context after a lost reply and reject changed requests", async () => {
  const f = await fixture()
  const sent: RunPrompt[] = []
  const runs = new BBRuns(
    f.folder,
    async () => ({ busy: false, messages: [] }),
    async (prompt) => {
      sent.push(structuredClone(prompt))
      throw new Error("Lost admission acknowledgement")
    },
    () => undefined,
  )
  await runs.start()
  runs.close()
  fixtures.push({ folder: f.folder, server: f.server, runs })
  const side = new BBSide(f.folder, f.request, runs)
  const child = await side.open("ses_parent", "ses_owner", f.folder, "Side")
  const raw: RunPrompt = {
    sessionID: child.id,
    directory: f.folder,
    id: "msg_lost_raw",
    text: "Explain the current work",
    model: { providerID: "test", modelID: "test", contextWindow: undefined },
    variant: "medium",
    files: [{ uri: "file:///immutable.png", name: "immutable.png" }],
    draft: { selection: "immutable attachment" },
  }
  const prepared = { ...(await side.prepare(raw)), recommendedContextWindow: 180_000 }
  await runs.call("admit", { prompt: prepared, immediate: true })
  for (let attempt = 0; attempt < 50 && runs.get(child.id).queue[0]?.status !== "uncertain"; attempt++)
    await Bun.sleep(2)
  const recorded = runs.get(child.id).queue[0].prompt
  expect(runs.get(child.id).queue[0].status).toBe("uncertain")
  expect(sent).toHaveLength(1)
  f.state.output = "Parent advanced after the lost acknowledgement"
  const retry = await side.prepare(raw, recorded)
  expect(retry).toEqual(recorded)
  const reloaded = JSON.parse(JSON.stringify(recorded)) as RunPrompt
  expect(Object.hasOwn(raw.model!, "contextWindow")).toBe(true)
  expect(Object.hasOwn(reloaded.model!, "contextWindow")).toBe(false)
  expect(await side.prepare(raw, reloaded)).toEqual(reloaded)
  expect(
    await side.prepare({ ...raw, model: { contextWindow: undefined, modelID: "test", providerID: "test" } }, reloaded),
  ).toEqual(reloaded)
  expect(JSON.stringify(retry.legacyParts)).toContain("First verified output")
  expect(JSON.stringify(retry.legacyParts)).not.toContain("Parent advanced")
  await runs.call("admit", { prompt: retry })
  expect(runs.get(child.id).queue).toHaveLength(1)
  expect(sent).toHaveLength(1)
  for (const changed of [
    { text: "Different question" },
    { variant: "high" },
    { model: { providerID: "other", modelID: "test" } },
    { files: [{ uri: "file:///changed.png", name: "immutable.png" }] },
    { draft: { selection: "changed attachment" } },
    { recommendedContextWindow: 250_000 },
  ])
    await expect(side.prepare({ ...raw, ...changed }, recorded)).rejects.toThrow("deliveryConflict")
})

test("side questions include ordinary parent requests, recent exchange and the currently owned action", async () => {
  const f = await fixture()
  const child = await f.side.open("ses_parent", "ses_owner", f.folder, "Side")
  f.runs.get("ses_parent").last = {
    id: "msg_current",
    sessionID: "ses_parent",
    directory: f.folder,
    text: "Create a game with a blue spaceship and explain its controls.",
  }
  f.state.messages = [
    { info: { id: "msg_previous", role: "user" }, parts: [{ type: "text", text: "Use arrow keys to move." }] },
    {
      info: { id: "msg_old_reply", role: "assistant", parentID: "msg_previous" },
      parts: [
        { type: "text", text: "I will use the arrow keys." },
        { type: "tool", tool: "old_tool", state: { status: "running" } },
      ],
    },
    {
      info: { id: "msg_current", role: "user" },
      parts: [
        { type: "text", text: "Create a game with a blue spaceship and explain its controls." },
        { type: "text", text: "Internal synthetic context", synthetic: true },
        { type: "file", filename: "spaceship.png" },
      ],
    },
    {
      info: { id: "msg_new_reply", role: "assistant", parentID: "msg_current" },
      parts: [
        { type: "text", text: "I am inspecting the existing game before adding the spaceship." },
        { type: "tool", tool: "read", state: { status: "running", title: "Read game.ts" } },
      ],
    },
  ]
  const progress = await f.side.progress(child.id)
  expect(progress.objective).toContain("blue spaceship")
  expect(progress.latestInput?.id).toBe("msg_current")
  expect(progress.currentInputID).toBe("msg_current")
  expect(progress.currentTool).toBe("read")
  expect(progress.currentAction?.title).toBe("Read game.ts")
  expect(progress.recentMessages.map((row) => row.text).join("\n")).toContain("arrow keys")
  expect(progress.recentMessages[2].files).toEqual(["spaceship.png"])
  expect(JSON.stringify(progress)).not.toContain("Internal synthetic context")
  const prepared = await f.side.prepare({
    id: "msg_question",
    sessionID: child.id,
    directory: f.folder,
    text: "What is it working on?",
  })
  expect(JSON.stringify(prepared.legacyParts)).toContain("blue spaceship")
  expect(JSON.stringify(prepared.legacyParts)).toContain("Read game.ts")
  expect(f.calls.filter((row) => row.startsWith("POST "))).toEqual(["POST /session"])
  f.state.phase = "idle"
  const idle = await f.side.progress(child.id)
  expect(idle.currentTool).toBeUndefined()
  expect(idle.currentInputID).toBeUndefined()
  expect(idle.latestInput?.text).toContain("blue spaceship")
})

test("inherited context is bounded, excludes queued task text and never re-executes the parent", async () => {
  const f = await fixture()
  const child = await f.side.open("ses_parent", "ses_owner", f.folder, "Side")
  f.state.messages = Array.from({ length: 8 }, (_, index) => ({
    info: { id: "msg_" + index, role: index % 2 ? "assistant" : "user" },
    parts: [{ type: "text", text: "Current parent exchange ".repeat(10000) }],
  }))
  const run = f.runs.get("ses_parent")
  run.last = { id: "msg_main", sessionID: "ses_parent", directory: f.folder, text: "Main request ".repeat(10000) }
  run.queue.push({
    id: "msg_pending",
    status: "pending",
    delivery: "queue",
    prompt: {
      id: "msg_pending",
      sessionID: "ses_parent",
      directory: f.folder,
      text: "Private queued instruction not yet executing",
    },
  })
  const result = await f.side.prepare({
    id: "msg_question",
    sessionID: child.id,
    directory: f.folder,
    text: "What are the latest requirements?",
  })
  const source = JSON.stringify(result.legacyParts)
  expect(source).toContain("Main request")
  expect(source).toContain("Current parent exchange")
  expect(source).not.toContain("Private queued instruction not yet executing")
  expect(source.length).toBeLessThan(14000)
  expect(f.calls.filter((row) => row.startsWith("POST "))).toEqual(["POST /session"])
  f.state.messages = []
  expect(await f.side.prepare(result)).toEqual(result)
  expect(f.runs.get("ses_parent").queue).toHaveLength(1)
})

test("closing validates ownership, stops only its child, archives it and preserves historical forks", async () => {
  const f = await fixture(),
    child = await f.side.open("ses_parent", "ses_owner", f.folder, "Side")
  const sibling = await f.side.open("ses_parent", "ses_owner", f.folder, "Side")
  expect(sibling.id).not.toBe(child.id)
  await expect(f.side.close(child.id, "ses_other_owner")).rejects.toThrow("sideOwnership")
  expect(f.children.find((row) => row.id === child.id)?.time).toBeUndefined()
  await Promise.all([
    f.side.close(child.id, "ses_owner"),
    f.side.close(child.id, "ses_owner"),
    f.side.close(child.id, "ses_owner"),
  ])
  await f.side.close(child.id, "ses_owner")
  expect(f.children.find((row) => row.id === child.id)?.time?.archived).toBeNumber()
  expect(f.calls.filter((row) => row === "PATCH /session/" + child.id)).toHaveLength(1)
  expect(f.runs.get("ses_parent").paused).toBe(false)
  expect(f.runs.get(child.id).pauseReason).toBe("user-stop")
  expect(f.children.find((row) => row.id === sibling.id)?.time).toBeUndefined()
  expect((await f.side.relation(sibling.id))?.state).toBe("open")
  expect(
    (await f.side.prepare({ id: "msg_sibling", text: "Hello", directory: f.folder, sessionID: sibling.id })).text,
  ).toBe("Hello")
  await f.side.close("ses_historical", "ses_owner")
  expect(f.children[0].time).toBeUndefined()
  await expect(
    f.side.prepare({ id: "msg_closed", text: "Hello", directory: f.folder, sessionID: child.id }),
  ).rejects.toThrow("sideClosed")
})

test("crash recovery reconciles a lost create acknowledgement and cleans only the immutable owned child", async () => {
  const f = await fixture()
  const sibling = await f.side.open("ses_parent", "ses_owner", f.folder, "Side")
  f.state.loseReply = true
  await expect(f.side.open("ses_parent", "ses_owner", f.folder, "Side")).rejects.toThrow("HTTP 503")
  const restored = new BBSide(f.folder, f.request, f.runs)
  await restored.recover()
  expect(f.state.posts).toBe(2)
  expect(f.children[1].time?.archived).toBeNumber()
  expect(f.children[2].time?.archived).toBeNumber()
  expect(f.children[0].time).toBeUndefined()
  expect(JSON.parse(await readFile(join(f.folder, "side-chats.json"), "utf8"))[0].state).toBe("closed")
  const fresh = await restored.open("ses_parent", "ses_owner", f.folder, "Side")
  expect(fresh.id).not.toBe(sibling.id)
  expect(fresh.id).not.toBe(f.children[1].id)
  expect(fresh.id).not.toBe(f.children[2].id)
  expect(f.state.posts).toBe(3)
})

test("V2 side context reads paginated current messages and authoritative ownership without legacy routes", async () => {
  const f = await fixture("v2")
  const child = await f.side.open("ses_parent", "ses_owner", f.folder, "Side", "v2")
  f.state.messages = [
    {
      info: { id: "msg_old", role: "assistant" },
      parts: [{ type: "tool", tool: "old_action", state: { status: "running" } }],
    },
    { info: { id: "msg_v2_input", role: "user" }, parts: [{ type: "text", text: "Build a blue spaceship game." }] },
    {
      info: { id: "msg_v2_assistant", role: "assistant" },
      parts: [
        { type: "text", text: "I am reading the game controls." },
        { type: "tool", tool: "read", state: { status: "running", title: "Read controls.ts" } },
      ],
    },
  ]
  const snapshot = await f.side.progress(child.id)
  expect(snapshot.phase).toBe("busy")
  expect(snapshot.currentInputID).toBe("msg_v2_input")
  expect(snapshot.currentTool).toBe("read")
  expect(snapshot.currentAction?.title).toBe("Read controls.ts")
  expect(snapshot.objective).toContain("blue spaceship")
  expect(snapshot.recentMessages[1].text).toContain("blue spaceship")
  const prompt = await f.side.prepare({
    sessionID: child.id,
    id: "msg_side",
    directory: f.folder,
    text: "What controls is it adding?",
  })
  expect(prompt.protocol).toBe("v2")
  expect(JSON.stringify(prompt.legacyParts)).toContain("Read controls.ts")
  expect(f.calls.every((call) => call.includes(" /api/"))).toBe(true)
  expect((await f.side.relation(child.id))?.protocol).toBe("v2")
})

test("V2 close verifies diagnostic ownership and archives only the selected child", async () => {
  const f = await fixture("v2")
  const child = await f.side.open("ses_parent", "ses_owner", f.folder, "Side", "v2")
  const sibling = await f.side.open("ses_parent", "ses_owner", f.folder, "Side", "v2")
  f.children.find((row) => row.id === child.id)!.diagnostic!.ownerID = "ses_stolen"
  await expect(f.side.close(child.id, "ses_owner")).rejects.toThrow("sideOwnership")
  expect(f.calls.some((call) => call.endsWith("/interrupt"))).toBe(false)
  f.children.find((row) => row.id === child.id)!.diagnostic!.ownerID = "ses_owner"
  await Promise.all([f.side.close(child.id, "ses_owner"), f.side.close(child.id, "ses_owner")])
  expect(f.children.find((row) => row.id === child.id)?.time?.archived).toBeNumber()
  expect(f.children.find((row) => row.id === sibling.id)?.time).toBeUndefined()
  expect(f.children[0].time).toBeUndefined()
  expect(f.calls.filter((call) => call === "POST /api/session/" + child.id + "/interrupt")).toHaveLength(1)
  expect(f.calls.filter((call) => call === "PATCH /api/organization/chats/" + child.id)).toHaveLength(1)
  expect(f.calls.some((call) => call.includes("ses_parent/interrupt"))).toBe(false)
})

test("V2 recovery reconciles the journaled create ID after a lost reply and retires a never-created child", async () => {
  const f = await fixture("v2")
  f.state.loseReply = true
  await expect(f.side.open("ses_parent", "ses_owner", f.folder, "Side", "v2")).rejects.toThrow("HTTP 503")
  const child = f.children[1]
  const recorded = JSON.parse(await readFile(join(f.folder, "side-chats.json"), "utf8"))
  expect(recorded[0].childID).toBe(child.id)
  expect(recorded[0].protocol).toBe("v2")
  await new BBSide(f.folder, f.request, f.runs).recover()
  expect(child.time?.archived).toBeNumber()
  expect(f.state.posts).toBe(1)
  f.state.failCreate = true
  await expect(f.side.open("ses_parent", "ses_owner", f.folder, "Side", "v2")).rejects.toThrow("HTTP 503")
  await new BBSide(f.folder, f.request, f.runs).recover()
  const recovered = JSON.parse(await readFile(join(f.folder, "side-chats.json"), "utf8"))
  expect(recovered.every((row: { state: string }) => row.state === "closed")).toBe(true)
  expect(f.state.posts).toBe(1)
  expect(f.children[0].time).toBeUndefined()
})
