import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { BBRuns } from "./bitsbytes-runs"
import { conversationProtocol, ownedConversations, removeOwnedConversation } from "./bitsbytes-conversations"

const fixtures: { root: string; runs: BBRuns; server: ReturnType<typeof Bun.serve> }[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.runs.close()
    fixture.server.stop(true)
    const root = resolve(fixture.root)
    if (
      !root.startsWith(resolve(tmpdir()) + "\\bb-conversation-test-") &&
      !root.startsWith(resolve(tmpdir()) + "/bb-conversation-test-")
    )
      throw new Error("Unexpected cleanup path")
    await rm(root, { recursive: true, force: true })
  }
})
async function setup(handler: (request: Request) => Response | Promise<Response>) {
  const root = await mkdtemp(join(tmpdir(), "bb-conversation-test-"))
  const dispatched: string[] = []
  const runs = new BBRuns(
    root,
    async () => ({ busy: true, messages: [] }),
    async (prompt) => {
      dispatched.push(prompt.id)
    },
    () => undefined,
  )
  await runs.start()
  runs.close()
  const server = Bun.serve({ port: 0, fetch: handler })
  fixtures.push({ root, runs, server })
  const ready = { url: server.url.toString().replace(/\/$/, ""), username: null, password: null }
  return { root, runs, server: ready, dispatched, directory: root, sessionID: "ses_root", protocol: "v2" as const }
}

describe("native conversation lifecycle", () => {
  test("detects V2 and enumerates only verified direct-parent ownership", async () => {
    const fixture = await setup((request) => {
      const path = new URL(request.url).pathname
      if (path === "/global/health") return new Response(null, { status: 404 })
      if (path === "/api/health") return Response.json({ pid: 123 })
      if (path.endsWith("/children"))
        return Response.json({
          data: path.endsWith("ses_root/children") ? [{ id: "ses_owned", parentID: "ses_root" }] : [],
        })
      return Response.json({ data: { id: "ses_root" } })
    })
    expect(await conversationProtocol(fixture.server, fixture.directory)).toBe("v2")
    expect(await ownedConversations(fixture)).toEqual(["ses_root", "ses_owned"])
  })
  test("deletion freezes admission and clears durable owned journals while retaining root forks", async () => {
    const deleting = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>()
    const fixture = await setup(async (request) => {
      const path = new URL(request.url).pathname
      if (request.method === "DELETE") {
        deleting.resolve()
        await finish.promise
        return new Response(null, { status: 204 })
      }
      if (path.endsWith("/children"))
        return Response.json({
          data: path.endsWith("ses_root/children") ? [{ id: "ses_owned", parentID: "ses_root" }] : [],
        })
      return Response.json({ data: { id: "ses_root" } })
    })
    for (const id of ["ses_root", "ses_owned", "ses_independent"]) {
      await fixture.runs.call("admit", {
        prompt: { sessionID: id, id: "msg_" + id, directory: fixture.directory, text: "Pending work" },
      })
    }
    const removal = removeOwnedConversation(fixture)
    await deleting.promise
    await expect(
      fixture.runs.call("admit", {
        prompt: { sessionID: "ses_root", id: "msg_late", directory: fixture.directory, text: "Late work" },
      }),
    ).rejects.toThrow("bb.error.deliveryConflict")
    await fixture.runs.pump("ses_root")
    expect(fixture.dispatched).toEqual([])
    finish.resolve()
    expect(await removal).toEqual(["ses_root", "ses_owned"])
    const stored = JSON.parse(await readFile(join(fixture.root, "chat-runs.json"), "utf8"))
    expect(Object.keys(stored)).toEqual(["ses_independent"])
    expect(fixture.runs.get("ses_independent").queue).toHaveLength(1)
    expect(() => fixture.runs.get("ses_root")).toThrow("bb.error.invalidRequest")
  })
  test("failed deletion retains the paused journal for an explicit retry", async () => {
    const fixture = await setup((request) => {
      const path = new URL(request.url).pathname
      if (request.method === "DELETE") return new Response("failure", { status: 503 })
      if (path.endsWith("/children")) return Response.json({ data: [] })
      return Response.json({ data: { id: "ses_root" } })
    })
    await fixture.runs.call("admit", {
      prompt: { sessionID: "ses_root", id: "msg_pending", directory: fixture.directory, text: "Keep draft" },
    })
    await expect(removeOwnedConversation(fixture)).rejects.toThrow("503")
    expect(fixture.runs.get("ses_root").paused).toBe(true)
    expect(fixture.runs.get("ses_root").queue[0].prompt.text).toBe("Keep draft")
    expect(JSON.parse(await readFile(join(fixture.root, "chat-runs.json"), "utf8")).ses_root.queue).toHaveLength(1)
  })
  test("rejects a child response containing an unrelated root before deletion", async () => {
    const fixture = await setup((request) =>
      Response.json(
        new URL(request.url).pathname.endsWith("/children")
          ? { data: [{ id: "ses_other" }] }
          : { data: { id: "ses_root" } },
      ),
    )
    await expect(removeOwnedConversation(fixture)).rejects.toThrow("organization.error.actionFailed")
  })
  test("legacy success must actually remove the session before clearing its journal", async () => {
    const fixture = await setup((request) => {
      if (request.method !== "GET") return Response.json(true)
      if (new URL(request.url).pathname.endsWith("/children")) return Response.json([])
      return Response.json({ id: "ses_root" })
    })
    await fixture.runs.call("admit", {
      prompt: {
        sessionID: "ses_root",
        id: "msg_pending",
        directory: fixture.directory,
        text: "Preserve pending request",
      },
    })
    await expect(removeOwnedConversation({ ...fixture, protocol: "v1" })).rejects.toThrow(
      "organization.error.actionFailed",
    )
    expect(fixture.runs.get("ses_root").queue).toHaveLength(1)
    expect(fixture.runs.get("ses_root").paused).toBe(true)
  })
  test("legacy actual not-found clears the journal after interruption and deletion", async () => {
    const state = { deleted: false },
      methods: string[] = []
    const fixture = await setup((request) => {
      methods.push(request.method + " " + new URL(request.url).pathname)
      if (request.method === "DELETE") {
        state.deleted = true
        return Response.json(true)
      }
      if (request.method !== "GET") return Response.json(true)
      if (new URL(request.url).pathname.endsWith("/children")) return Response.json([])
      return state.deleted ? new Response("not found", { status: 404 }) : Response.json({ id: "ses_root" })
    })
    await fixture.runs.call("admit", {
      prompt: { sessionID: "ses_root", id: "msg_pending", directory: fixture.directory, text: "Pending request" },
    })
    expect(await removeOwnedConversation({ ...fixture, protocol: "v1" })).toEqual(["ses_root"])
    expect(Object.keys(JSON.parse(await readFile(join(fixture.root, "chat-runs.json"), "utf8")))).toEqual([])
    expect(methods.slice(-3)).toEqual([
      "POST /session/ses_root/abort",
      "DELETE /session/ses_root",
      "GET /session/ses_root",
    ])
  })
})
