import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createServer, type ServerResponse } from "node:http"
import { resolve } from "node:path"
import { createInterface } from "node:readline"

type Message = { id?: number; method?: string; result?: { tools?: { name: string }[]; capabilities?: { tools?: { listChanged?: boolean } } } }

test("MCP image tool discovery follows verified capability changes without restarting the adapter", async () => {
  const state = { available: false, model: "fixture-image-model", revision: 0, requests: 0, authorized: 0, failure: false }
  const pending = new Set<ServerResponse>()
  const longPolls: number[] = []
  const observers = new Set<() => void>()
  const messages: Message[] = []
  const notify = () => { for (const observer of [...observers]) observer() }
  const until = (condition: () => boolean) => {
    if (condition()) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const inspect = () => { if (condition()) { clearTimeout(timer); observers.delete(inspect); resolve() } }
      const timer = setTimeout(() => { observers.delete(inspect); reject(new Error("Local MCP fixture timed out")) }, 2500)
      observers.add(inspect)
    })
  }
  const reply = (response: ServerResponse) => {
    response.writeHead(state.failure ? 503 : 200, { "Content-Type": "application/json" })
    response.end(JSON.stringify({ available: state.available, model: state.model, revision: state.revision }))
  }
  const change = (value: Partial<typeof state>) => {
    Object.assign(state, value)
    state.revision++
    for (const response of [...pending]) { pending.delete(response); reply(response) }
  }
  const server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    state.requests++
    if (incoming.headers.authorization === "Bearer local-mcp-fixture-token") state.authorized++
    if (input.name !== "images.capabilities") { response.writeHead(400); response.end("{}"); return }
    if (input.arguments?.revision === state.revision && !state.failure) {
      pending.add(response)
      longPolls.push(state.revision)
      response.once("close", () => pending.delete(response))
      notify()
      return
    }
    reply(response)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Fixture did not open a local TCP port")
  const child = spawn(process.execPath, [resolve("resources/bitsbytes/mcp.mjs")], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, BITSBYTES_TOOL_URL: `http://127.0.0.1:${address.port}/tools`, BITSBYTES_TOOL_TOKEN: "local-mcp-fixture-token" },
  })
  const stderr: Buffer[] = []
  child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)))
  const lines = createInterface({ input: child.stdout })
  lines.on("line", line => { messages.push(JSON.parse(line)); notify() })
  let id = 0
  const send = (method: string, params?: Record<string, unknown>) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n")
  const request = async (method: string) => {
    const current = ++id
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: current, method, params: {} }) + "\n")
    await until(() => messages.some(message => message.id === current))
    return messages.find(message => message.id === current)!
  }
  const changes = () => messages.filter(message => message.method === "notifications/tools/list_changed").length
  try {
    expect((await request("initialize")).result?.capabilities?.tools?.listChanged).toBe(true)
    expect(state.requests).toBe(0)
    send("notifications/initialized")
    await until(() => longPolls.includes(0))
    const before = (await request("tools/list")).result?.tools?.map(tool => tool.name) ?? []
    expect(before).toContain("publish_artifact")
    expect(before).not.toContain("generate_image")
    expect(changes()).toBe(0)

    change({ available: true })
    await until(() => changes() === 1)
    const enabled = (await request("tools/list")).result?.tools?.map(tool => tool.name) ?? []
    expect(enabled).toContain("generate_image")
    expect(enabled.filter(name => name !== "generate_image")).toEqual(before)

    change({})
    await until(() => longPolls.includes(2))
    expect(changes()).toBe(1)

    change({ model: "fixture-image-model-two" })
    await until(() => changes() === 2)
    expect((await request("tools/list")).result?.tools?.some(tool => tool.name === "generate_image")).toBe(true)

    change({ available: false })
    await until(() => changes() === 3)
    expect((await request("tools/list")).result?.tools?.map(tool => tool.name)).toEqual(before)

    change({ failure: true })
    expect((await request("tools/list")).result?.tools?.map(tool => tool.name)).toEqual(before)
    expect(state.requests).toBe(state.authorized)
    expect(Buffer.concat(stderr).toString("utf8")).not.toContain("local-mcp-fixture-token")
    const exited = new Promise<number | null>(resolve => child.once("exit", resolve))
    child.stdin.end()
    expect(await Promise.race([exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Adapter did not stop after stdin closed")), 1500))])).toBe(0)
  } finally {
    child.kill()
    lines.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}, 15000)
