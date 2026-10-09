import { afterEach, describe, expect, test } from "bun:test"
import { createConversationActions } from "./conversation-actions"
import { createServer } from "node:http"
import type { Server } from "node:http"

const servers: Server[] = []
afterEach(() =>
  servers.splice(0).forEach((server) => {
    server.closeAllConnections()
    server.close()
  }),
)

async function service(
  protocol: "v1" | "v2",
  handler: (request: Request) => Response | Promise<Response>,
  options: { fetch?: typeof fetch; onRemoved?: (ids: string[]) => void } = {},
) {
  const server = createServer(async (incoming, outgoing) => {
    outgoing.setHeader("Access-Control-Allow-Origin", "*")
    outgoing.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
    outgoing.setHeader("Access-Control-Allow-Headers", "Content-Type, x-opencode-directory")
    outgoing.setHeader("Access-Control-Expose-Headers", "X-Next-Cursor")
    if (incoming.method === "OPTIONS") {
      outgoing.writeHead(204)
      outgoing.end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    const method = incoming.method ?? "GET"
    const response = await handler(
      new Request(`http://127.0.0.1${incoming.url}`, {
        method,
        body: chunks.length ? Buffer.concat(chunks).toString() : undefined,
      }),
    )
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()))
    outgoing.end(Buffer.from(await response.arrayBuffer()))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(server)
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected HTTP server address")
  const copied: string[] = [],
    assignments: { id: string; projectID?: string | null }[] = []
  const actions = createConversationActions({
    sdk: {
      server: { type: "http", http: { url: `http://127.0.0.1:${address.port}` } },
      protocol: Promise.resolve(protocol),
    },
    platform: {
      fetch: options.fetch,
      writeClipboardText: async (text) => {
        copied.push(text)
      },
    },
    organization: {
      chat: async (id, input) => {
        assignments.push({ id, projectID: input.projectID })
        return { id, title: "branch", directory: "D:\\Chat", pinned: false, order: 0, created: 1, updated: 1 }
      },
    },
    labels: { user: "User", assistant: "Assistant" },
    onRemoved: options.onRemoved,
  })
  return { actions, copied, assignments }
}
const chat = { id: "ses_source", title: "Saved conversation", directory: "D:\\Chat", projectID: "project_test" }

describe("conversation sidebar actions", () => {
  test("copies every V2 page in order without private reasoning or raw tool arguments", async () => {
    const queries: string[] = []
    const fixture = await service("v2", (request) => {
      const url = new URL(request.url)
      queries.push(url.search)
      if (url.searchParams.get("cursor") === "next")
        return Response.json({
          data: [
            {
              id: "msg_a",
              type: "assistant",
              content: [
                { type: "reasoning", text: "private" },
                { type: "tool", name: "internal", input: "secret" },
                { type: "text", text: "Answer" },
              ],
              time: { created: 2, completed: 3 },
            },
          ],
          cursor: {},
        })
      return Response.json({
        data: [
          {
            id: "msg_u",
            type: "user",
            text: "Question",
            files: [{ name: "original.png", uri: "data:image/png;base64,secret" }],
            time: { created: 1 },
          },
        ],
        cursor: { next: "next" },
      })
    })
    await fixture.actions.copyConversation(chat)
    expect(queries).toEqual(["?limit=200&order=asc", "?limit=200&cursor=next"])
    expect(fixture.copied[0]).toBe(
      "# Saved conversation\n\n## User\n\nQuestion\n\noriginal.png\n\n## Assistant\n\nAnswer\n",
    )
    await fixture.actions.copyTitle(chat)
    expect(fixture.copied[1]).toBe(chat.title)
  })
  test("legacy forks select a completed turn and exclude later running work", async () => {
    const boundaries: unknown[] = []
    const fixture = await service("v1", async (request) => {
      if (request.method === "POST") {
        boundaries.push(await request.json())
        return Response.json({ id: "ses_branch" })
      }
      return Response.json([
        { info: { id: "msg_running", role: "assistant", time: { created: 4 } }, parts: [] },
        {
          info: { id: "msg_tool", role: "assistant", finish: "tool-calls", time: { created: 3, completed: 3 } },
          parts: [],
        },
        { info: { id: "msg_done", role: "assistant", finish: "stop", time: { created: 2, completed: 2 } }, parts: [] },
        { info: { id: "msg_user", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "Question" }] },
      ])
    })
    const [first, second] = await Promise.all([fixture.actions.fork(chat), fixture.actions.fork(chat)])
    expect(first).toEqual({ id: "ses_branch", directory: chat.directory })
    expect(second).toEqual(first)
    expect(boundaries).toEqual([{ messageID: "msg_done", inclusive: true }])
    expect(fixture.assignments).toEqual([{ id: "ses_branch", projectID: chat.projectID }])
  })
  test("legacy forks fail before mutating when there is no completed turn", async () => {
    const mutations: string[] = []
    const fixture = await service("v1", (request) => {
      if (request.method !== "GET") mutations.push(request.method)
      return Response.json([{ info: { id: "msg_running", role: "assistant", time: { created: 1 } }, parts: [] }])
    })
    await expect(fixture.actions.fork(chat)).rejects.toThrow("organization.error.noCompletedTurn")
    expect(mutations).toEqual([])
  })
  test("deletes only owned descendants and keeps independent branches", async () => {
    const requests: string[] = [],
      removed: string[][] = []
    const fixture = await service("v2", (request) => {
      const path = new URL(request.url).pathname
      requests.push(request.method + " " + path)
      if (request.method === "DELETE") return new Response(null, { status: 204 })
      return Response.json({
        data: path.endsWith("ses_source/children") ? [{ id: "ses_owned", parentID: "ses_source" }] : [],
      })
    })
    const listen = (event: Event) => removed.push((event as CustomEvent<{ sessionIDs: string[] }>).detail.sessionIDs)
    window.addEventListener("opencode:session-tabs-removed", listen)
    try {
      expect(await fixture.actions.remove(chat)).toEqual(["ses_source", "ses_owned"])
      expect(removed).toEqual([["ses_source", "ses_owned"]])
      expect(requests).toEqual([
        "GET /api/session/ses_source/children",
        "GET /api/session/ses_owned/children",
        "DELETE /api/session/ses_source",
      ])
    } finally {
      window.removeEventListener("opencode:session-tabs-removed", listen)
    }
  })
  test("legacy deletion preserves tabs when DELETE reports success but an owned session remains", async () => {
    const callbacks: string[][] = [],
      notifications: string[][] = []
    const fixture = await service(
      "v1",
      (request) => {
        const path = new URL(request.url).pathname
        if (path.endsWith("/children"))
          return Response.json(path.endsWith("ses_source/children") ? [{ id: "ses_owned", parentID: "ses_source" }] : [])
        if (request.method !== "GET") return new Response(null, { status: 204 })
        if (path.endsWith("ses_source")) return new Response(null, { status: 404 })
        return Response.json({ id: "ses_owned" })
      },
      { onRemoved: (ids) => callbacks.push(ids) },
    )
    const listen = (event: Event) => notifications.push((event as CustomEvent<{ sessionIDs: string[] }>).detail.sessionIDs)
    window.addEventListener("opencode:session-tabs-removed", listen)
    try {
      await expect(fixture.actions.remove(chat)).rejects.toThrow("organization.error.actionFailed")
      expect(callbacks).toEqual([])
      expect(notifications).toEqual([])
    } finally {
      window.removeEventListener("opencode:session-tabs-removed", listen)
    }
  })
  test("legacy deletion notifies only after every owned session is authoritatively absent", async () => {
    const callbacks: string[][] = [],
      notifications: string[][] = [],
      requests: string[] = []
    const inspected = Promise.withResolvers<void>(),
      confirmation = Promise.withResolvers<Response>()
    const fixture = await service(
      "v1",
      (request) => {
        const path = new URL(request.url).pathname
        requests.push(request.method + " " + path)
        if (path.endsWith("/children"))
          return Response.json(path.endsWith("ses_source/children") ? [{ id: "ses_owned", parentID: "ses_source" }] : [])
        if (request.method !== "GET") return new Response(null, { status: 204 })
        if (path.endsWith("ses_owned")) {
          inspected.resolve()
          return confirmation.promise
        }
        return new Response(null, { status: 404 })
      },
      { onRemoved: (ids) => callbacks.push(ids) },
    )
    const listen = (event: Event) => notifications.push((event as CustomEvent<{ sessionIDs: string[] }>).detail.sessionIDs)
    window.addEventListener("opencode:session-tabs-removed", listen)
    try {
      const removal = fixture.actions.remove(chat)
      await inspected.promise
      expect(callbacks).toEqual([])
      expect(notifications).toEqual([])
      confirmation.resolve(new Response(null, { status: 404 }))
      expect(await removal).toEqual(["ses_source", "ses_owned"])
      expect(callbacks).toEqual([["ses_source", "ses_owned"]])
      expect(notifications).toEqual([["ses_source", "ses_owned"]])
      expect(requests).toEqual([
        "GET /session/ses_source/children",
        "GET /session/ses_owned/children",
        "POST /session/ses_source/abort",
        "POST /session/ses_owned/abort",
        "DELETE /session/ses_source",
        "GET /session/ses_source",
        "GET /session/ses_owned",
      ])
    } finally {
      confirmation.resolve(new Response(null, { status: 404 }))
      window.removeEventListener("opencode:session-tabs-removed", listen)
    }
  })
  test.each([401, 503])("legacy deletion preserves tabs when confirmation returns HTTP %s", async (status) => {
    const callbacks: string[][] = [],
      notifications: string[][] = []
    const fixture = await service(
      "v1",
      (request) => {
        const path = new URL(request.url).pathname
        if (path.endsWith("/children")) return Response.json([])
        return new Response(null, { status: request.method === "GET" ? status : 204 })
      },
      { onRemoved: (ids) => callbacks.push(ids) },
    )
    const listen = (event: Event) => notifications.push((event as CustomEvent<{ sessionIDs: string[] }>).detail.sessionIDs)
    window.addEventListener("opencode:session-tabs-removed", listen)
    try {
      await expect(fixture.actions.remove(chat)).rejects.toThrow("organization.error.actionFailed")
      expect(callbacks).toEqual([])
      expect(notifications).toEqual([])
    } finally {
      window.removeEventListener("opencode:session-tabs-removed", listen)
    }
  })
  test("legacy deletion preserves tabs when absence confirmation loses its connection", async () => {
    const callbacks: string[][] = [],
      notifications: string[][] = []
    const transport: typeof fetch = Object.assign(
      (request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (new URL(String(request)).pathname.endsWith("ses_source") && (init?.method ?? "GET") === "GET")
          return Promise.reject(new TypeError("connection lost"))
        return fetch(request, init)
      },
      { preconnect: fetch.preconnect },
    )
    const fixture = await service(
      "v1",
      (request) => {
        const path = new URL(request.url).pathname
        if (path.endsWith("/children")) return Response.json([])
        return new Response(null, { status: 204 })
      },
      { fetch: transport, onRemoved: (ids) => callbacks.push(ids) },
    )
    const listen = (event: Event) => notifications.push((event as CustomEvent<{ sessionIDs: string[] }>).detail.sessionIDs)
    window.addEventListener("opencode:session-tabs-removed", listen)
    try {
      await expect(fixture.actions.remove(chat)).rejects.toThrow("connection lost")
      expect(callbacks).toEqual([])
      expect(notifications).toEqual([])
    } finally {
      window.removeEventListener("opencode:session-tabs-removed", listen)
    }
  })
  test("legacy conversation copy follows older pages and preserves visible attachments", async () => {
    const fixture = await service("v1", (request) => {
      const older = new URL(request.url).searchParams.get("before")
      if (older)
        return Response.json([
          {
            info: { id: "msg_user", role: "user", time: { created: 1 } },
            parts: [
              { type: "text", text: "Question" },
              { type: "text", text: "private system instructions", synthetic: true },
              { type: "file", filename: "plan.md", url: "file:///D:/Chat/plan.md" },
            ],
          },
        ])
      return Response.json(
        [
          {
            info: { id: "msg_done", role: "assistant", time: { created: 2, completed: 3 } },
            parts: [
              { type: "text", text: "Answer" },
              { type: "reasoning", text: "private thoughts" },
            ],
          },
        ],
        { headers: { "X-Next-Cursor": "older" } },
      )
    })
    expect(await fixture.actions.markdown(chat)).toBe(
      "# Saved conversation\n\n## User\n\nQuestion\n\n[plan.md](<file:///D:/Chat/plan.md>)\n\n## Assistant\n\nAnswer\n",
    )
  })
  test("a failed membership save retries the same created branch", async () => {
    const branchIDs: string[] = [],
      assignments: string[] = []
    const server = createServer(async (incoming, outgoing) => {
      outgoing.setHeader("Access-Control-Allow-Origin", "*")
      outgoing.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
      outgoing.setHeader("Access-Control-Allow-Headers", "Content-Type, x-opencode-directory")
      if (incoming.method === "OPTIONS") {
        outgoing.writeHead(204)
        outgoing.end()
        return
      }
      branchIDs.push("ses_one")
      outgoing.setHeader("Content-Type", "application/json")
      outgoing.end(JSON.stringify({ data: { id: "ses_one" } }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    servers.push(server)
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected HTTP address")
    const actions = createConversationActions({
      sdk: {
        server: { type: "http", http: { url: `http://127.0.0.1:${address.port}` } },
        protocol: Promise.resolve("v2"),
      },
      platform: {},
      labels: { user: "User", assistant: "Assistant" },
      organization: {
        chat: async (id) => {
          assignments.push(id)
          if (assignments.length === 1) throw new Error("offline")
          return undefined
        },
      },
    })
    await expect(actions.fork(chat)).rejects.toThrow("offline")
    expect(await actions.fork(chat)).toEqual({ id: "ses_one", directory: chat.directory })
    expect(branchIDs).toEqual(["ses_one"])
    expect(assignments).toEqual(["ses_one", "ses_one"])
  })
})
