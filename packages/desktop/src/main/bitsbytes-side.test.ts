import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BBSide } from "./bitsbytes-side"
import { BBRuns } from "./bitsbytes-runs"

type Child = {
  id: string
  parentID: string
  metadata?: { bitsbytesDiagnostic?: { key: string; parentID: string; ownerID: string } }
  time?: { archived?: number }
}
const fixtures: { folder: string; server: ReturnType<typeof Bun.serve>; runs: BBRuns }[] = []
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "bb-side-test-"))
  const children: Child[] = [{ id: "ses_historical", parentID: "ses_parent" }]
  const calls: string[] = []
  const state = { phase: "busy", output: "First verified output", posts: 0, loseReply: false }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname
      calls.push(request.method + " " + path)
      if (path === "/session/status") return Response.json({ ses_parent: { type: state.phase } })
      if (path === "/question" || path === "/permission") return Response.json([])
      if (path.endsWith("/message"))
        return Response.json([
          {
            info: { id: "msg_parent", role: "assistant" },
            parts: [{ type: "tool", tool: "read", state: { status: "completed", output: state.output } }],
          },
        ])
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
    if (!response.ok) throw Error("HTTP " + response.status)
    return (await response.json()) as T
  }
  return { folder, runs, children, calls, state, request, side: new BBSide(folder, request, runs) }
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

test("concurrent side opens reconcile one owned child and grant only read tools", async () => {
  const f = await fixture()
  const [first, second] = await Promise.all([
    f.side.open("ses_parent", "ses_owner", f.folder, "Side"),
    f.side.open("ses_parent", "ses_owner", f.folder, "Side"),
  ])
  expect(first.id).toBe(second.id)
  expect(f.state.posts).toBe(1)
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
  expect(JSON.parse(await readFile(join(f.folder, "side-chats.json"), "utf8"))[0]).toMatchObject({
    childID: first.id,
    state: "open",
  })
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

test("closing validates ownership, stops only its child, archives it and preserves historical forks", async () => {
  const f = await fixture(),
    child = await f.side.open("ses_parent", "ses_owner", f.folder, "Side")
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
  await f.side.close("ses_historical", "ses_owner")
  expect(f.children[0].time).toBeUndefined()
  await expect(
    f.side.prepare({ id: "msg_closed", text: "Hello", directory: f.folder, sessionID: child.id }),
  ).rejects.toThrow("sideClosed")
})

test("crash recovery reconciles a lost create acknowledgement and cleans only the immutable owned child", async () => {
  const f = await fixture()
  f.state.loseReply = true
  await expect(f.side.open("ses_parent", "ses_owner", f.folder, "Side")).rejects.toThrow("HTTP 503")
  const restored = new BBSide(f.folder, f.request, f.runs)
  await restored.recover()
  expect(f.state.posts).toBe(1)
  expect(f.children[1].time?.archived).toBeNumber()
  expect(f.children[0].time).toBeUndefined()
  expect(JSON.parse(await readFile(join(f.folder, "side-chats.json"), "utf8"))[0].state).toBe("closed")
  const fresh = await restored.open("ses_parent", "ses_owner", f.folder, "Side")
  expect(fresh.id).not.toBe(f.children[1].id)
})
