import { afterEach, expect, test } from "bun:test"
import { createServer } from "node:http"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { dispatchEngine, inspectEngine } from "./bitsbytes-engine"
import { BBRuns, type RunPrompt } from "./bitsbytes-runs"

const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
async function fixture(protocol: "v1" | "v2") {
  const root = await mkdtemp(join(tmpdir(), "bb-admission-test-"))
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const state = {
    hold: "",
    requests: [] as { path: string; body: Record<string, unknown> }[],
    prompts: [] as { id: string; text: string }[],
  }
  const http = createServer(async (request, response) => {
    let source = ""
    for await (const chunk of request) source += chunk
    const body = JSON.parse(source || "{}") as Record<string, unknown>
    const path = request.url ?? ""
    if (request.method === "POST") {
      state.requests.push({ path, body })
      if (path.endsWith("/prompt_async") || path.endsWith("/prompt"))
        state.prompts.push({ id: String(body.messageID ?? body.id), text: "Accepted source" })
      if (state.hold && path.endsWith(state.hold)) {
        entered.resolve()
        await release.promise
      }
      if (!response.destroyed) response.writeHead(204).end()
      return
    }
    const rows = state.prompts.flatMap((prompt) => [
      { id: prompt.id, type: "user", text: prompt.text },
      { id: "msg_z" + prompt.id, type: "assistant", text: "Completed" },
    ])
    const value =
      path === "/session/status"
        ? {}
        : path === "/api/session/active"
          ? { data: {} }
          : protocol === "v1"
            ? rows.map((row) => ({ info: { id: row.id, role: row.type }, parts: [{ type: "text", text: row.text }] }))
            : { data: rows }
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify(value))
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const address = http.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture address")
  const f = {
    root,
    protocol,
    state,
    http,
    entered,
    release,
    server: { url: `http://127.0.0.1:${address.port}`, username: null, password: null },
    prompt: { sessionID: "ses_test", directory: root, id: "msg_test", text: "Visible request", protocol } as RunPrompt,
  }
  fixtures.push(f)
  return f
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.release.resolve()
    f.http.closeAllConnections()
    await new Promise<void>((resolve) => f.http.close(() => resolve()))
    if (!resolve(f.root).startsWith(join(resolve(tmpdir()), "bb-admission-test-")))
      throw new Error("Unexpected cleanup path")
    await rm(f.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test("V1 admission resolves each app-owned source once and retains the native payload", async () => {
  const f = await fixture("v1"),
    resolved: string[] = []
  const uri = "bitsbytes://transcript/source?revision=3"
  const prompt = {
    ...f.prompt,
    agent: "build",
    model: { providerID: "fixture", modelID: "fixture" },
    variant: "low",
    legacyParts: [
      { type: "text", text: "Visible request" },
      { type: "file", url: uri },
    ],
    files: [{ uri }, { uri: "https://example.invalid/source" }],
  }
  await dispatchEngine(f.server, prompt, {
    protocol: "v1",
    contextRoot: join(f.root, "context"),
    resolveAttachment: async (uri) => {
      resolved.push(uri)
    },
  })
  expect(resolved).toEqual([uri])
  expect(f.state.requests).toEqual([
    {
      path: "/session/ses_test/prompt_async",
      body: { messageID: prompt.id, agent: "build", model: prompt.model, variant: "low", parts: prompt.legacyParts },
    },
  ])
})

test("V2 admission retains selected model, visible text and frozen synthetic context", async () => {
  const f = await fixture("v2"),
    contextRoot = join(f.root, "context")
  const prompt: RunPrompt = {
    ...f.prompt,
    mode: "plan",
    agent: "plan",
    model: { providerID: "fixture", modelID: "fixture" },
    variant: "low",
    delivery: "steer",
    legacyParts: [
      { type: "text", text: "Visible request" },
      { type: "text", text: "Read-only frozen plan context", synthetic: true },
    ],
  }
  await dispatchEngine(f.server, prompt, { protocol: "v2", contextRoot, resolveAttachment: async () => undefined })
  expect(f.state.requests.map((request) => request.path)).toEqual([
    "/api/session/ses_test/agent",
    "/api/session/ses_test/model",
    "/api/session/ses_test/prompt",
  ])
  expect(f.state.requests[1].body).toEqual({ model: { id: "fixture", providerID: "fixture", variant: "low" } })
  expect(f.state.requests[2].body).toEqual({
    id: "msg_test",
    prompt: { text: "Visible request", files: [{ uri: "bitsbytes://run/msg_test", name: "Plan" }] },
    delivery: "steer",
  })
  expect(await readFile(join(contextRoot, "msg_test.txt"), "utf8")).toBe("Read-only frozen plan context")
})

test.each(["v1", "v2"] as const)(
  "%s Stop during source preparation keeps the original unsent request for Resume",
  async (protocol) => {
    const f = await fixture(protocol),
      entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>(),
      settled = Promise.withResolvers<void>(),
      protocols = new Map<string, "v1" | "v2">()
    const runs = new BBRuns(
      f.root,
      (prompt, options) => inspectEngine(f.server, prompt, protocols, options),
      (prompt, signal) =>
        dispatchEngine(f.server, prompt, {
          protocol,
          contextRoot: join(f.root, "context"),
          signal,
          resolveAttachment: async () => {
            entered.resolve()
            await release.promise
          },
        }),
      (id) => {
        if (!runs.get(id).queue.length) settled.resolve()
      },
    )
    await runs.start()
    runs.close()
    runs.get("ses_test").paused = true
    await runs.call("admit", {
      prompt: { ...f.prompt, legacyParts: [{ type: "file", url: "bitsbytes://transcript/source?revision=3" }] },
    })
    runs.get("ses_test").paused = false
    const pumping = runs.pump("ses_test")
    try {
      await entered.promise
      await runs.call("stop", { sessionID: "ses_test" })
      release.resolve()
      await pumping
      expect(f.state.prompts).toEqual([])
      expect(runs.get("ses_test")).toMatchObject({
        paused: true,
        awaiting: false,
        queue: [{ id: "msg_test", status: "pending" }],
      })
      expect(runs.get("ses_test").queue[0].sentAt).toBeUndefined()
      expect(JSON.parse(await readFile(join(f.root, "chat-runs.json"), "utf8")).ses_test.queue[0].status).toBe(
        "pending",
      )
      await runs.call("resume", { sessionID: "ses_test" })
      for (let index = 0; index < 100 && runs.get("ses_test").queue.length; index++) {
        await Bun.sleep(5)
        await runs.pump("ses_test")
      }
      expect(f.state.prompts.map((prompt) => prompt.id)).toEqual(["msg_test"])
      expect(runs.get("ses_test").queue).toHaveLength(0)
      await settled.promise
    } finally {
      release.resolve()
      await pumping
      runs.close()
    }
  },
)

test.each(["v1", "v2"] as const)(
  "%s Stop releases a stalled admission and reconciles its possible acknowledgement without replay",
  async (protocol) => {
    const f = await fixture(protocol),
      settled = Promise.withResolvers<void>(),
      protocols = new Map<string, "v1" | "v2">()
    f.state.hold = protocol === "v1" ? "/prompt_async" : "/prompt"
    const runs = new BBRuns(
      f.root,
      (prompt, options) => inspectEngine(f.server, prompt, protocols, options),
      (prompt, signal) =>
        dispatchEngine(f.server, prompt, {
          protocol,
          contextRoot: join(f.root, "context"),
          signal,
          resolveAttachment: async () => undefined,
        }),
      (id) => {
        if (!runs.get(id).queue.length) settled.resolve()
      },
    )
    await runs.start()
    runs.close()
    runs.get("ses_test").paused = true
    await runs.call("admit", { prompt: f.prompt })
    runs.get("ses_test").paused = false
    const pumping = runs.pump("ses_test")
    try {
      await f.entered.promise
      await runs.call("stop", { sessionID: "ses_test" })
      await pumping
      expect(runs.get("ses_test")).toMatchObject({
        paused: true,
        awaiting: false,
        error: "bb.error.deliveryUnknown",
        queue: [{ id: "msg_test", status: "uncertain", error: "bb.error.deliveryUnknown" }],
      })
      expect(runs.get("ses_test").queue[0].sentAt).toBeDefined()
      expect(f.state.prompts).toHaveLength(1)
      await runs.call("resume", { sessionID: "ses_test" })
      for (let index = 0; index < 100 && runs.get("ses_test").queue.length; index++) {
        await Bun.sleep(5)
        await runs.pump("ses_test")
      }
      expect(runs.get("ses_test").queue).toHaveLength(0)
      expect(f.state.prompts).toHaveLength(1)
      await settled.promise
    } finally {
      f.release.resolve()
      await pumping
      runs.close()
    }
  },
)

test("V2 cancellation during selection does not admit a prompt or create its context", async () => {
  const f = await fixture("v2"),
    controller = new AbortController()
  f.state.hold = "/model"
  const pending = dispatchEngine(
    f.server,
    {
      ...f.prompt,
      agent: "plan",
      model: { providerID: "fixture", modelID: "fixture" },
      legacyParts: [{ type: "text", text: "Frozen context", synthetic: true }],
    },
    {
      protocol: "v2",
      contextRoot: join(f.root, "context"),
      signal: controller.signal,
      resolveAttachment: async () => undefined,
    },
  )
  await f.entered.promise
  controller.abort()
  expect(await pending).toBe("not-sent")
  expect(f.state.prompts).toEqual([])
  expect(await readdir(f.root)).not.toContain("context")
})

test("synthetic context IDs cannot write outside their context folder", async () => {
  const f = await fixture("v2")
  await expect(
    dispatchEngine(
      f.server,
      { ...f.prompt, id: "../escaped", legacyParts: [{ type: "text", text: "Context", synthetic: true }] },
      { protocol: "v2", contextRoot: join(f.root, "context"), resolveAttachment: async () => undefined },
    ),
  ).rejects.toThrow("bb.error.invalidRequest")
  expect(await readdir(f.root)).toEqual([])
  expect(f.state.prompts).toEqual([])
})
