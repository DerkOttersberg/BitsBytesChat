import { afterEach, expect, test } from "bun:test"
import { createServer } from "node:http"
import { inspectEngine } from "./bitsbytes-engine"
import { BBRuns } from "./bitsbytes-runs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const servers: ReturnType<typeof createServer>[] = []
async function fixture(protocol: "v1" | "v2") {
  const state = { busy: true, requests: [] as string[], output: "working", error: { message: "fixture error" } as unknown, parentID: "msg_user" as unknown, created: 123 as unknown }
  const server = createServer((request, response) => {
    state.requests.push(request.url!)
    response.setHeader("content-type", "application/json")
    if (request.url === "/global/health") {
      response.end(JSON.stringify(protocol === "v1" ? { healthy: true } : { status: "ok" }))
      return
    }
    if (request.url === "/session/status") {
      response.end(JSON.stringify({ ses_test: { type: state.busy ? "busy" : "idle" } }))
      return
    }
    if (request.url === "/api/session/active") {
      response.end(JSON.stringify({ data: state.busy ? { ses_test: { type: "running" } } : {} }))
      return
    }
    const tool = {
      type: "tool",
      tool: "read",
      name: "read",
      state: { input: { path: "fixture.txt" }, output: state.output },
    }
    const rows =
      protocol === "v1"
        ? [
            { info: { id: "msg_user", role: "user" }, parts: [{ type: "text", text: "Source" }] },
            {
              info: {
                id: "msg_assistant",
                role: "assistant",
                parentID: state.parentID,
                time: { created: state.created },
                tokens: { input: 10, output: 4 },
                error: state.error,
              },
              parts: [{ type: "text", text: "Answer" }, tool],
            },
          ]
        : [
            { id: "msg_user", type: "user", text: "Source" },
            {
              id: "msg_assistant",
              type: "assistant",
              tokens: { input: 10, output: 4 },
              error: state.error,
              content: [{ type: "text", text: "Answer" }, tool],
            },
          ]
    response.end(JSON.stringify(protocol === "v1" ? rows : { data: rows }))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture address")
  return {
    state,
    server: { url: `http://127.0.0.1:${address.port}`, username: null, password: null },
    prompt: { id: "msg_probe", sessionID: "ses_test", directory: "D:\\QA", text: "Probe" },
  }
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test.each(["v1", "v2"] as const)(
  "%s inspection retains message text, tools, tokens, errors and changing progress",
  async (protocol) => {
    const f = await fixture(protocol),
      protocols = new Map<string, "v1" | "v2">()
    const initial = await inspectEngine(f.server, f.prompt, protocols)
    expect(initial.busy).toBe(true)
    expect(protocols.get("ses_test")).toBe(protocol)
    expect(initial.messages[0]).toMatchObject({ id: "msg_user", text: "Source", assistant: false, tokens: 0, tools: 0 })
    expect(initial.messages[1]).toMatchObject({
      id: "msg_assistant",
      text: "Answer",
      assistant: true,
      tokens: 14,
      tools: 1,
      error: '{"message":"fixture error"}',
    })
    expect(initial.messages[1].progress).toMatch(/^[a-f0-9]{64}$/)
    f.state.busy = false
    f.state.output = "finished"
    const final = await inspectEngine(f.server, f.prompt, protocols)
    expect(final.busy).toBe(false)
    expect(final.messages[1].progress).not.toBe(initial.messages[1].progress)
    expect(f.state.requests.filter((path) => path === "/global/health")).toHaveLength(1)
  },
)

test("V1 inspection retains typed cancellation ownership without inferring it from error text", async () => {
  const f = await fixture("v1"), protocols = new Map<string, "v1" | "v2">()
  const aborted = { name: "MessageAbortedError", data: { message: "Aborted" } }
  f.state.error = aborted
  const result = await inspectEngine(f.server, f.prompt, protocols)
  expect(result.messages[1]).toMatchObject({ parentID: "msg_user", created: 123, aborted: true, error: JSON.stringify(aborted) })
  for (const error of ["MessageAbortedError", { message: "MessageAbortedError" }, { name: "UnknownError", data: { message: "Aborted" } }]) {
    f.state.error = error
    expect((await inspectEngine(f.server, f.prompt, protocols)).messages[1]).toMatchObject({ aborted: false, error: JSON.stringify(error) })
  }
  f.state.parentID = 42; f.state.created = "123"
  const damaged = (await inspectEngine(f.server, f.prompt, protocols)).messages[1]
  expect(damaged.parentID).toBeUndefined()
  expect(damaged.created).toBeUndefined()
})

test("V2 generic interruption retains its error and supplies no invented cancellation ownership", async () => {
  const f = await fixture("v2")
  f.state.error = { type: "unknown", message: "Provider turn interrupted" }
  const message = (await inspectEngine(f.server, f.prompt, new Map())).messages[1]
  expect(message.error).toBe(JSON.stringify(f.state.error))
  expect(message.aborted).toBeUndefined()
  expect(message.parentID).toBeUndefined()
  expect(message.created).toBeUndefined()
})

test("retrying an uncertain admission still reconciles its late acknowledgement while the engine is busy", async () => {
  const f = await fixture("v1"), root = await mkdtemp(join(tmpdir(), "bb-inspection-retry-"))
  const protocols = new Map<string, "v1" | "v2">()
  const sent: string[] = []
  const runs = new BBRuns(root, (prompt, options) => inspectEngine(f.server, prompt, protocols, options), async prompt => { sent.push(prompt.id) }, () => undefined)
  try {
    await runs.start(); runs.close()
    const chat = runs.get("ses_test")
    chat.queue.push({ id: "msg_user", delivery: "queue", status: "pending", sentAt: Date.now(), prompt: { ...f.prompt, id: "msg_user", protocol: "v1" } })
    await runs.pump("ses_test")
    expect(chat.queue).toHaveLength(0)
    expect(sent).toEqual([])
    expect(f.state.requests).toContain("/session/ses_test/message")
  } finally {
    runs.close()
    if (!resolve(root).startsWith(join(resolve(tmpdir()), "bb-inspection-retry-"))) throw new Error("Unexpected cleanup path")
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

test("explicit protocol selection overrides a cached protocol without probing health", async () => {
  const f = await fixture("v1"),
    protocols = new Map<string, "v1" | "v2">([["ses_test", "v2"]])
  const result = await inspectEngine(f.server, { ...f.prompt, protocol: "v1" }, protocols)
  expect(result.messages).toHaveLength(2)
  expect(protocols.get("ses_test")).toBe("v1")
  expect(f.state.requests).toEqual(["/session/status", "/session/ses_test/message"])
})

test.each(["v1", "v2"] as const)(
  "%s busy summary skips history, then an idle inspection retrieves complete history",
  async (protocol) => {
    const f = await fixture(protocol),
      protocols = new Map<string, "v1" | "v2">()
    const prompt = { ...f.prompt, protocol }
    expect(await inspectEngine(f.server, prompt, protocols, { readBusyMessages: false })).toEqual({
      busy: true,
      messages: [],
    })
    expect(f.state.requests).toEqual([protocol === "v1" ? "/session/status" : "/api/session/active"])
    f.state.busy = false
    const idle = await inspectEngine(f.server, prompt, protocols, { readBusyMessages: false })
    expect(idle.busy).toBe(false)
    expect(idle.messages).toHaveLength(2)
    expect(idle.messages[1].text).toBe("Answer")
    expect(f.state.requests).toHaveLength(3)
  },
)
