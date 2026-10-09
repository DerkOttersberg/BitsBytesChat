import { afterEach, expect, test } from "bun:test"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { dispatchEngine, engineRequest, inspectEngine } from "./bitsbytes-engine"
import { BBRuns } from "./bitsbytes-runs"

const servers: ReturnType<typeof createServer>[] = []
async function fixture(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture address")
  return { url: `http://127.0.0.1:${address.port}`, username: "qa", password: "fixture-only" }
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test("engine metadata retains authentication, encoded workspace and response semantics", async () => {
  const seen: { url?: string; auth?: string; directory?: string; custom?: string }[] = []
  const server = await fixture((request, response) => {
    seen.push({ url: request.url, auth: request.headers.authorization, directory: String(request.headers["x-opencode-directory"]), custom: String(request.headers["x-qa"]) })
    if (request.url === "/empty") { response.writeHead(204); response.end(); return }
    if (request.url === "/bad") { response.writeHead(503); response.end("unavailable"); return }
    response.setHeader("content-type", "application/json"); response.end('{"ready":true}')
  })
  expect(await engineRequest(server, "/metadata", { headers: { "x-qa": "kept" } }, "D:\\QA space\\é")).toEqual({ ready: true })
  expect(seen[0]).toEqual({ url: "/metadata", auth: "Basic " + Buffer.from("qa:fixture-only").toString("base64"), directory: encodeURIComponent("D:\\QA space\\é"), custom: "kept" })
  expect(await engineRequest(server, "/empty", {}, "D:\\QA")).toBeUndefined()
  await expect(engineRequest(server, "/bad", {}, "D:\\QA")).rejects.toThrow("Bits & Bytes Chat 503: unavailable")
})

test("explicit V2 Resume posts no new prompt, model or user attachment", async () => {
  const seen: { url?: string; body: string }[] = []
  const server = await fixture(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk
    seen.push({ url: request.url, body }); response.writeHead(204).end()
  })
  await dispatchEngine(server, { id: "msg_saved", sessionID: "ses_saved", directory: "D:/QA", text: "Original task", resume: true, model: { providerID: "qa", modelID: "qa" }, agent: "build", legacyParts: [{ type: "file", url: "bitsbytes://transcript/frozen?revision=1" }] }, { protocol: "v2", contextRoot: "D:/QA", resolveAttachment: async () => { throw new Error("Resume should not resolve new attachments") } })
  expect(seen).toEqual([{ url: "/api/session/ses_saved/resume", body: "" }])
})

test.each(["v1", "v2"] as const)("%s dispatch preserves the saved context choice independently of effort", async protocol => {
  const seen: { url?: string; body: Record<string, any> }[] = []
  const server = await fixture(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk
    seen.push({ url: request.url, body: JSON.parse(body || "{}") })
    response.writeHead(204).end()
  })
  await dispatchEngine(server, { id: "msg_budget", sessionID: "ses_budget", directory: "D:/QA", text: "Budget", model: { providerID: "qa", modelID: "qa", contextWindow: 64_000 }, variant: "medium", legacyParts: [{ type: "text", text: "Budget" }] }, { protocol, contextRoot: "D:/QA", resolveAttachment: async () => ({ text: "" }) })
  const model = seen.find(row => row.body.model)?.body.model
  expect(model).toMatchObject({ providerID: "qa", contextWindow: 64_000 })
  expect(protocol === "v2" ? model.variant : seen.find(row => row.body.model)?.body.variant).toBe("medium")
  expect(JSON.stringify(seen)).not.toContain("max_output_tokens")
})

test.each(["v1", "v2"] as const)("%s dispatch carries frozen Recommended while keeping the manual choice absent", async protocol => {
  const seen: { model?: { contextWindow?: number; recommendedContextWindow?: number } }[] = []
  const server = await fixture(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk
    seen.push(JSON.parse(body || "{}")); response.writeHead(204).end()
  })
  await dispatchEngine(server, { id: "msg_economy", sessionID: "ses_economy", directory: "D:/owned-qa", text: "Budget", model: { providerID: "qa", modelID: "qa" }, recommendedContextWindow: 200_000, variant: "medium" }, { protocol, contextRoot: "D:/owned-qa", resolveAttachment: async () => ({ text: "" }) })
  expect(seen.find(row => row.model)?.model).toMatchObject({ recommendedContextWindow: 200_000 })
  expect(seen.find(row => row.model)?.model?.contextWindow).toBeUndefined()
  expect(JSON.stringify(seen)).not.toContain("max_output_tokens")
})

test("V2 Goal inspection excludes waiting questions and Goal bookkeeping from progress", async () => {
  let question = true, remaining = 100, read = false
  const server = await fixture((request, response) => {
    response.setHeader("content-type", "application/json")
    if (request.url?.endsWith("/question")) { response.end(JSON.stringify({ data: question ? [{ id: "que_owned" }] : [] })); return }
    if (request.url?.endsWith("/permission")) { response.end('{"data":[]}'); return }
    if (request.url === "/api/session/active") { response.end('{"data":{"ses_owned":{}}}'); return }
    response.end(JSON.stringify({ data: [{ id: "msg_assistant", type: "assistant", content: [{ type: "tool", name: "bitsbytes_get_goal", state: { output: { remaining } } }, ...(read ? [{ type: "tool", name: "read", state: { output: "Recorded file" } }] : [])] }] }))
  })
  const prompt = { id: "msg_owned", sessionID: "ses_owned", text: "Work", directory: "D:/QA", protocol: "v2" as const }
  const first = await inspectEngine(server, prompt, new Map(), { readWaitingState: true })
  expect(first.waiting).toBe(true)
  expect(first.messages[0]).toMatchObject({ tools: 0, progress: undefined })
  question = false; remaining = 90; read = true
  const next = await inspectEngine(server, prompt, new Map(), { readWaitingState: true })
  expect(next.waiting).toBe(false)
  expect(next.messages[0].tools).toBe(1)
  remaining = 80
  expect((await inspectEngine(server, prompt, new Map())).messages[0].progress).toBe(next.messages[0].progress)
})

test.each(["headers", "body"])("a stalled metadata %s read expires and a later read works", async phase => {
  const server = await fixture((request, response) => {
    if (request.url === "/ready") { response.end('{"ready":true}'); return }
    if (phase === "body") { response.setHeader("content-type", "application/json"); response.write('{"unfinished":'); response.flushHeaders() }
  })
  const started = Date.now()
  await expect(engineRequest(server, "/stalled", {}, "D:\\QA")).rejects.toThrow("bb.error.engineTimeout")
  expect(Date.now() - started).toBeGreaterThanOrEqual(14000)
  expect(Date.now() - started).toBeLessThan(19000)
  expect(await engineRequest(server, "/ready", {}, "D:\\QA")).toEqual({ ready: true })
}, 20000)

test("caller cancellation works for both metadata and mutations", async () => {
  const server = await fixture(() => undefined)
  for (const method of ["GET", "POST"]) {
    const controller = new AbortController()
    const pending = engineRequest(server, "/stalled", { method, signal: controller.signal }, "D:\\QA")
    controller.abort(new Error("QA cancelled"))
    await expect(pending).rejects.toThrow("QA cancelled")
  }
})

test("a slow mutation is sent once and is not cut off by the metadata deadline", async () => {
  let requests = 0
  const server = await fixture((request, response) => {
    requests++
    setTimeout(() => response.end('{"admitted":true}'), 15200)
  })
  expect(await engineRequest(server, "/prompt", { method: "POST", body: '{"id":"stable-id"}' }, "D:\\QA")).toEqual({ admitted: true })
  expect(requests).toBe(1)
}, 20000)

test("Stop during a stalled engine read preserves the queue for explicit Resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "bb-engine-runs-test-"))
  const entered = Promise.withResolvers<void>()
  const sent: string[] = []
  let healthy = false
  const server = await fixture(async (request, response) => {
    if (request.url === "/metadata") {
      entered.resolve()
      if (!healthy) return
      response.end(JSON.stringify({ busy: false, messages: sent.map(id => ({ id, text: "", tokens: 0, tools: 0 })) })); return
    }
    let body = ""; for await (const chunk of request) body += chunk
    sent.push(JSON.parse(body).id)
    response.end("{}")
  })
  const runs = new BBRuns(root, prompt => engineRequest(server, "/metadata", {}, prompt.directory), async prompt => {
    await engineRequest(server, "/prompt", { method: "POST", body: JSON.stringify(prompt) }, prompt.directory)
  }, () => undefined)
  try {
    await runs.start(); runs.close()
    runs.get("ses_timeout").paused = true
    await runs.call("admit", { prompt: { id: "msg_preserved", sessionID: "ses_timeout", text: "Preserve this request", directory: root } })
    runs.get("ses_timeout").paused = false
    const pending = runs.pump("ses_timeout")
    await entered.promise
    await runs.call("stop", { sessionID: "ses_timeout" })
    await pending
    expect(sent).toEqual([])
    expect(runs.get("ses_timeout").queue[0].status).toBe("pending")
    expect(runs.get("ses_timeout").paused).toBe(true)
    healthy = true
    await runs.pump("ses_timeout")
    expect(sent).toEqual([])
    await runs.call("resume", { sessionID: "ses_timeout" })
    const started = Date.now()
    while (!sent.length || runs.get("ses_timeout").queue[0]?.status !== "sending") {
      if (Date.now() - started > 5000) throw new Error("Preserved request did not resume")
      await Bun.sleep(20)
    }
    await runs.pump("ses_timeout")
    expect(sent).toEqual(["msg_preserved"])
  } finally {
    runs.close()
    if (!resolve(root).startsWith(join(resolve(tmpdir()), "bb-engine-runs-test-"))) throw new Error("Unexpected cleanup path")
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
}, 20000)
