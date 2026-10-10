import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { constants, setPriority } from "node:os"
import { join, resolve } from "node:path"

// Fictional credentials and loopback inference only; every window belongs to this QA profile.
setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
const root = resolve("../..")
const { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const profile = join(root, ".tools/qa/provider-side-settings-" + randomUUID())
const data = join(profile, "BitsBytesChat"), directory = join(data, "workspace")
const results = join(root, ".tools/qa/results")
const name = process.env.BB_QA_REPORT || "provider-side-settings"
const report = { profile, checks: [], requests: [], errors: [], paidRequests: false }
const fixture = createServer(async (request, response) => {
  let source = ""
  for await (const chunk of request) source += chunk
  const body = JSON.parse(source)
  report.requests.push({ model: body.model, headers: {
    session: request.headers["x-opencode-session"],
    request: request.headers["x-opencode-request"],
    client: request.headers["x-opencode-client"],
    parent: request.headers["x-opencode-parent-session-id"],
    userAgent: request.headers["user-agent"],
  }, messages: body.messages })
  response.writeHead(200, { "content-type": "text/event-stream" })
  const row = { id: "fixture-response", object: "chat.completion.chunk", created: 1, model: body.model }
  response.write("data: " + JSON.stringify({ ...row, choices: [{ index: 0, delta: { role: "assistant", content: "Verified fixture reply." }, finish_reason: null }] }) + "\n\n")
  response.write("data: " + JSON.stringify({ ...row, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }) + "\n\n")
  response.end("data: [DONE]\n\n")
})
await new Promise(done => fixture.listen(0, "127.0.0.1", done))
await Promise.all([directory, join(data, "config/opencode"), results].map(path => mkdir(path, { recursive: true })))
await writeFile(join(data, "config/opencode/opencode.json"), JSON.stringify({
  model: "opencode/fixture",
  small_model: "opencode/fixture",
  provider: {
    opencode: { name: "OpenCode fixture", npm: "@ai-sdk/openai-compatible", whitelist: ["fixture"],
      options: { baseURL: `http://127.0.0.1:${fixture.address().port}/v1`, apiKey: "public" },
      models: { fixture: { name: "Free fixture", tool_call: true, cost: { input: 0, output: 0 }, limit: { context: 128000, output: 8192 } } } },
    "bitsbytes-chatgpt": { name: "Stale disconnected ChatGPT", npm: "@ai-sdk/openai", options: { apiKey: "old-proxy-key" }, models: {} },
  },
}))
const poll = async (read, accept, label) => {
  for (let attempt = 0; attempt < 250; attempt++) {
    const value = await read()
    if (accept(value)) return value
    await new Promise(done => setTimeout(done, 100))
  }
  throw Error("Timed out: " + label)
}
const check = label => { report.checks.push(label); console.log("PASS", label) }
let app, page
try {
  app = await _electron.launch({
    executablePath: process.env.BB_QA_EXECUTABLE || join(root, "packages/desktop/node_modules/electron/dist/electron.exe"),
    args: process.env.BB_QA_MAIN ? [process.env.BB_QA_MAIN] : [],
    env: { ...process.env, BB_QA_ISOLATED: "1", BB_QA_HIDDEN: "1", LOCALAPPDATA: profile }, timeout: 90000,
  })
  page = await app.firstWindow()
  page.on("pageerror", error => report.errors.push(error.message))
  await page.locator(".bb-org-sidebar").waitFor({ timeout: 90000 })
  const call = (method, args = {}) => page.evaluate(({ method, args }) => window.api.bitsbytes.call(method, args), { method, args })
  const server = await page.evaluate(() => window.api.awaitInitialization())
  const config = JSON.parse(await readFile(join(data, "config/opencode/opencode.json"), "utf8"))
  assert.equal(Object.hasOwn(config.provider, "bitsbytes-chatgpt"), false)
  check("Disconnected ChatGPT-plan proxy is removed from configuration instead of becoming a phantom connection")
  const headers = { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(directory) }
  if (server.password) headers.authorization = "Basic " + Buffer.from(`${server.username ?? "opencode"}:${server.password}`).toString("base64")
  const api = async (path, method = "GET", body) => {
    const response = await fetch(server.url + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
    assert.ok(response.ok, `${method} ${path}: ${await response.clone().text()}`)
    return response.status === 204 ? undefined : response.json()
  }
  const bridge = config.mcp["bitsbytes-local"].environment
  const credential = async (name, args = {}) => {
    const response = await fetch(bridge.BITSBYTES_TOOL_URL, { method: "POST", headers: { Authorization: "Bearer " + bridge.BITSBYTES_TOOL_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ name, arguments: args }) })
    assert.equal(response.ok, true)
    return response.json()
  }
  await credential("credentials.set", { key: "openai/", info: { type: "api", key: "obsolete-fixture" } })
  await credential("credentials.set", { key: "openai", info: { type: "api", key: "native-fixture" } })
  assert.deepEqual((await credential("credentials.all")).openai, { type: "api", key: "native-fixture" })
  assert.equal(Object.hasOwn(await credential("credentials.all"), "openai/"), false)
  await credential("credentials.v2.create", { id: "native-current", integrationID: "openai", label: "Native", value: { type: "oauth", access: "fictional", refresh: "rotated", expires: Date.now() + 3600000 } })
  await credential("credentials.v2.import", { records: [{ id: "native-old", integrationID: "openai", label: "Old", value: { type: "oauth", access: "fictional-old", refresh: "revoked", expires: 1 } }] })
  const native = (await credential("credentials.v2.all")).filter(row => row.integrationID === "openai")
  assert.equal(native.length, 1)
  assert.equal(native[0].id, "native-current")
  assert.equal(native[0].value.refresh, "rotated")
  await credential("credentials.v2.remove", { id: "native-current" })
  await api("/global/dispose", "POST")
  check("Legacy reconnect canonicalizes IDs; stale native imports preserve the current rotating grant")
  await page.locator(".bb-org-account").getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.locator(".settings-v2-dialog")
  await settings.getByRole("tab", { name: "Providers", exact: true }).click()
  await settings.locator('[data-component="connected-providers-section"]').getByText("OpenAI", { exact: true }).waitFor()
  assert.equal(await settings.locator(".bb-settings-panel").count(), 0)
  assert.equal(await settings.getByText("ChatGPT plan", { exact: true }).count(), 0)
  check("Providers uses one native connection interface without the duplicate ChatGPT login block")
  await page.keyboard.press("Escape")
  const parent = await api("/session", "POST", { title: "Main fixture conversation", permission: [{ permission: "*", pattern: "*", action: "deny" }] })
  const admit = async (sessionID, text) => {
    const id = "msg_" + ((BigInt(Date.now()) * 4096n) & 0xffffffffffffn).toString(16).padStart(12, "0") + randomUUID().replaceAll("-", "").slice(0, 14)
    await call("runs.admit", { delivery: "queue", prompt: { id, sessionID, directory, protocol: "v1", text, agent: "build", model: { providerID: "opencode", modelID: "fixture" } } })
    return poll(() => api(`/session/${sessionID}/message`), rows => rows.some(row => row.info.role === "assistant" && row.parts.some(part => part.type === "text" && part.text.includes("Verified fixture reply.")) && row.info.time.completed), "completed fixture reply")
  }
  await admit(parent.id, "Remember this main-chat fact: blue spaceship.")
  await page.evaluate(detail => window.dispatchEvent(new CustomEvent("bitsbytes:session", { detail })), { directory, sessionID: parent.id })
  await page.locator(`.bb-workspace-chat[data-bb-chat="${parent.id}"]`).waitFor()
  await page.evaluate(detail => window.dispatchEvent(new CustomEvent("bitsbytes:side-chat", { detail })), { directory, source: parent.id, model: { providerID: "opencode", modelID: "fixture" }, variant: null, agent: "build" })
  await page.locator('.bb-panel-header [role="tab"]').filter({ hasText: "Side chat" }).waitFor()
  const child = (await api(`/session/${parent.id}/children`)).find(row => row.metadata?.bitsbytesDiagnostic)
  assert.ok(child)
  assert.equal(await page.locator(".bb-side-parent-context").count(), 0)
  const rows = await admit(child.id, "What did I just ask in the main chat?")
  assert.ok(rows.some(row => row.info.role === "user"))
  const sideRequest = report.requests.find(row => row.headers.session === child.id)
  const mainRequest = report.requests.find(row => row.headers.session === parent.id)
  assert.ok(sideRequest && mainRequest)
  for (const row of [mainRequest, sideRequest]) {
    assert.match(row.headers.userAgent, /^opencode\//)
    assert.equal(row.headers.client, "desktop")
    assert.ok(row.headers.request)
  }
  assert.equal(sideRequest.headers.parent, parent.id)
  assert.ok(JSON.stringify(sideRequest.messages).includes("blue spaceship"))
  check("Actual main/side OpenCode inference shares engine identity and inherited context; the side banner is absent")
  assert.deepEqual(report.errors, [])
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible() || window.isFocused())), false)
} catch (error) { report.failure = error.stack || String(error); throw error }
finally {
  await app?.close()
  fixture.closeAllConnections()
  await new Promise(done => fixture.close(done))
  await writeFile(join(results, name + ".json"), JSON.stringify(report, null, 2))
}
