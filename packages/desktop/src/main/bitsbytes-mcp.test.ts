import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { resolve } from "node:path"
import { stateRecord } from "./bitsbytes-state"

async function fixture(call: (body: Record<string, unknown>, request: Request) => Promise<Response>) {
  const requests: Record<string, unknown>[] = []
  const notifications: Record<string, unknown>[] = []
  const watchers = new Set<() => void>()
  const notification = Promise.withResolvers<Record<string, unknown>>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer fixture-only")
      const body: unknown = await request.json()
      if (!stateRecord(body)) return Response.json({ error: "invalid fixture request" }, { status: 400 })
      if (body.name === "images.capabilities") {
        if (stateRecord(body.arguments) && body.arguments.revision === 1)
          await new Promise<void>((done) => {
            watchers.add(done)
            request.signal.addEventListener("abort", done, { once: true })
          })
        return Response.json({
          available: true,
          provider: "openrouter",
          model: "fixture",
          supportsEditing: true,
          revision: 1,
        })
      }
      requests.push(body)
      return call(body, request)
    },
  })
  const child = spawn(process.execPath, [resolve("resources/bitsbytes/mcp.mjs")], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, BITSBYTES_TOOL_URL: server.url.href, BITSBYTES_TOOL_TOKEN: "fixture-only" },
  })
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<Record<string, unknown>>>>()
  const counter = { value: 0 }
  const input = createInterface({ input: child.stdout })
  child.stderr.resume()
  input.on("line", (line) => {
    const message: unknown = JSON.parse(line)
    if (!stateRecord(message)) return
    if (typeof message.id !== "number") {
      notifications.push(message)
      if (message.method === "notifications/progress") notification.resolve(message)
      return
    }
    pending.get(message.id)?.resolve(message)
    pending.delete(message.id)
  })
  child.once("exit", () => {
    for (const item of pending.values()) item.reject(new Error("MCP fixture exited"))
    pending.clear()
  })
  const send = (message: Record<string, unknown>) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n")
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const id = ++counter.value
    const response = Promise.withResolvers<Record<string, unknown>>()
    pending.set(id, response)
    send({ id, method, params })
    return response.promise
  }
  const close = async () => {
    const exited =
      child.exitCode !== null ? Promise.resolve() : new Promise<void>((done) => child.once("exit", () => done()))
    child.stdin.end()
    child.kill()
    for (const done of watchers) done()
    server.stop(true)
    await exited
    input.close()
  }
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "local-fixture", version: "1" },
  })
  send({ method: "notifications/initialized" })
  return { request, send, requests, notifications, notification, close }
}

test("actual MCP adapter preserves native JSON results and reference-photo ownership", async () => {
  const values: unknown[] = [[1, 2], [], true, false, null, 17, "fixture"]
  const runtime = await fixture(async (body) =>
    Response.json(values[Number(stateRecord(body.arguments) ? (body.arguments.index ?? 0) : 0)]),
  )
  try {
    const listed = await runtime.request("tools/list")
    expect(listed.result).toMatchObject({
      tools: expect.arrayContaining([expect.objectContaining({ name: "generate_image" })]),
    })
    for (let index = 0; index < values.length; index++) {
      const response = await runtime.request("tools/call", { name: "read_artifact_pages", arguments: { index } })
      expect(response.result).toEqual({
        content: [{ type: "text", text: JSON.stringify(values[index]) }],
        isError: false,
        _meta: { bitsbytesJson: true },
      })
    }
    await runtime.request("tools/call", {
      name: "generate_image",
      arguments: {
        prompt: "Merge fixture photos",
        referenced_image_paths: ["C:/fixtures/a.png", "C:/fixtures/b.webp"],
      },
      _meta: { sessionID: "session-fixture", callID: "call-fixture", inputID: "input-fixture" },
    })
    expect(runtime.requests.at(-1)).toEqual({
      name: "generate_image",
      arguments: {
        prompt: "Merge fixture photos",
        referenced_image_paths: ["C:/fixtures/a.png", "C:/fixtures/b.webp"],
      },
      _meta: { sessionID: "session-fixture", callID: "call-fixture", inputID: "input-fixture" },
    })
  } finally {
    await runtime.close()
  }
})

test("actual MCP adapter keeps tool failures visible and preserves native content blocks", async () => {
  const runtime = await fixture(async (body) =>
    body.name === "failed"
      ? Response.json({ error: "fixture denied" }, { status: 403 })
      : Response.json({ content: [{ type: "text", text: "fixture content" }], _meta: { fixture: true } }),
  )
  try {
    const failed = await runtime.request("tools/call", { name: "failed", arguments: {} })
    expect(failed.result).toMatchObject({
      isError: true,
      structuredContent: { error: "fixture denied" },
      _meta: { bitsbytesJson: true },
    })
    const content = await runtime.request("tools/call", { name: "content", arguments: {} })
    expect(content.result).toEqual({
      content: [{ type: "text", text: "fixture content" }],
      isError: false,
      _meta: { fixture: true },
    })
  } finally {
    await runtime.close()
  }
})

test("actual MCP adapter reports progress during a slow image request without submitting it twice", async () => {
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const runtime = await fixture(async () => {
    started.resolve()
    await finish.promise
    return Response.json({ status: "ready", job_id: "fixture-job" })
  })
  try {
    const response = runtime.request("tools/call", {
      name: "generate_image",
      arguments: { prompt: "Fixture image" },
      _meta: { progressToken: "fixture-progress" },
    })
    await started.promise
    expect(await runtime.notification.promise).toMatchObject({
      method: "notifications/progress",
      params: { progressToken: "fixture-progress", progress: 1 },
    })
    expect(runtime.requests).toHaveLength(1)
    finish.resolve()
    expect((await response).result).toMatchObject({
      isError: false,
      structuredContent: { status: "ready", job_id: "fixture-job" },
    })
  } finally {
    finish.resolve()
    await runtime.close()
  }
}, 22000)

test("actual MCP adapter cancels a held call without returning a success or resubmitting", async () => {
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const runtime = await fixture(async () => {
    started.resolve()
    await finish.promise
    return Response.json({ status: "ready" })
  })
  try {
    const response = runtime.request("tools/call", {
      name: "generate_image",
      arguments: { prompt: "Canceled fixture" },
    })
    await started.promise
    runtime.send({ method: "notifications/cancelled", params: { requestId: 2 } })
    expect(await response).toMatchObject({ error: { code: -32603 } })
    expect(runtime.requests).toHaveLength(1)
  } finally {
    finish.resolve()
    await runtime.close()
  }
})
