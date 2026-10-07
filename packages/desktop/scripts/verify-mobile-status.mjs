import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { createServer } from "node:http"
import { mkdir, readFile, writeFile, symlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"

const root = resolve("../..")
const { _electron, chromium } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const profile = join(root, ".tools/qa/mobile-status-" + randomUUID()),
  data = join(profile, "BitsBytesChat")
const report = { checks: [], errors: [], responseBytes: [], providerRequests: 0, frozenSourceReachedProvider: false }
const source = "FROZEN-SOURCE-SENTINEL\n" + "Nederlandse bron 🌿 ".repeat(6000)
const fixture = createServer(async (request, response) => {
  let body = ""
  for await (const chunk of request) body += chunk
  report.providerRequests++
  const input = JSON.parse(body)
  report.frozenSourceReachedProvider ||= (input.messages ?? []).some(message =>
    (typeof message.content === "string" ? [message.content] : (message.content ?? []).filter(part => part.type === "text").map(part => part.text))
      .some(text => text.includes(source)),
  )
  response.writeHead(200, { "content-type": "text/event-stream" })
  response.end(
    "data: " +
      JSON.stringify({
        id: "fixture",
        object: "chat.completion.chunk",
        choices: [
          { index: 0, delta: { role: "assistant", content: "Resumed the preserved request." }, finish_reason: null },
        ],
      }) +
      "\n\ndata: " +
      JSON.stringify({
        id: "end",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
      }) +
      "\n\ndata: [DONE]\n\n",
  )
})
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve))
await mkdir(join(data, "config/opencode"), { recursive: true })
await symlink(join(process.env.LOCALAPPDATA, "BitsBytesChat/runtime"), join(data, "runtime"), "junction")
await writeFile(
  join(data, "config/opencode/opencode.json"),
  JSON.stringify({
    model: "status-qa/fixture",
    provider: {
      "status-qa": {
        name: "Status QA",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:" + fixture.address().port + "/v1", apiKey: "fixture-only" },
        models: { fixture: { name: "Status fixture", limit: { context: 128000, output: 8192 } } },
      },
    },
  }),
)
let app, browser
const check = (label) => {
  report.checks.push(label)
  console.log("PASS", label)
}
try {
  app = await _electron.launch({
    executablePath:
      process.env.BB_QA_EXECUTABLE || join(root, "packages/desktop/node_modules/electron/dist/electron.exe"),
    args: [process.env.BB_QA_MAIN || join(root, "packages/desktop")],
    env: { ...process.env, LOCALAPPDATA: profile },
    timeout: 90000,
  })
  const desktop = await app.firstWindow()
  desktop.on("pageerror", (error) => report.errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.hide()))
  await desktop.locator("[contenteditable=true]").first().waitFor({ timeout: 90000 })
  const call = (method, args = {}) =>
    desktop.evaluate(({ method, args }) => window.api.bitsbytes.call(method, args), { method, args })
  const server = await desktop.evaluate(() => window.api.awaitInitialization())
  const headers = {
    "content-type": "application/json",
    "x-opencode-directory": encodeURIComponent(join(data, "workspace")),
    ...(server.password
      ? {
          authorization:
            "Basic " + Buffer.from(`${server.username ?? "opencode"}:${server.password}`).toString("base64"),
        }
      : {}),
  }
  const response = await fetch(server.url + "/session", {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Frozen queue status QA" }),
    signal: AbortSignal.timeout(15000),
  })
  assert.ok(response.ok)
  const session = await response.json()
  await call("runs.stop", { sessionID: session.id })
  const prompt = {
    sessionID: session.id,
    directory: join(data, "workspace"),
    id:
      "msg_" +
      BigInt.asUintN(48, BigInt(Date.now()) * 4096n)
        .toString(16)
        .padStart(12, "0") +
      "abcdefabcdefab",
    text: source + "\nResume probe",
    agent: "build",
    model: { providerID: "status-qa", modelID: "fixture" },
    legacyParts: [
      { type: "text", text: "Resume probe" },
      { type: "text", text: source, synthetic: true },
    ],
  }
  await call("runs.admit", { prompt })
  const { createServer } = await import("node:net")
  const available = createServer()
  await new Promise((resolve) => available.listen(0, "127.0.0.1", resolve))
  const port = available.address().port
  await new Promise((resolve) => available.close(resolve))
  await call("mobile.enable", { port })
  const invitation = await call("mobile.pair")
  browser = await chromium.launch({ headless: true, channel: "msedge" })
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } })
  const phone = await context.newPage()
  phone.on("pageerror", (error) => report.errors.push(error.message))
  await phone.goto(`https://127.0.0.1:${port}/#pair=${invitation.token}`)
  await phone.getByRole("button", { name: "Pair a phone", exact: true }).click()
  let approved = false
  for (let index = 0; index < 100; index++) {
    const state = await call("mobile.state")
    if (state.requests.length) {
      await call("mobile.approve", { id: state.requests[0].id })
      approved = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(approved)
  await phone.locator("#app").waitFor({ state: "visible" })
  const chat = async (label) => {
    const result = await phone.evaluate(async (id) => {
      const response = await fetch("/api", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "chat", args: { sessionID: id } }),
      })
      if (!response.ok) throw Error("Chat HTTP " + response.status)
      return response.text()
    }, session.id)
    const value = JSON.parse(result)
    report.responseBytes.push({
      label,
      bytes: Buffer.byteLength(result),
      runBytes: Buffer.byteLength(JSON.stringify(value.run)),
      includesFrozenSource: result.includes("FROZEN-SOURCE-SENTINEL"),
    })
    if (process.env.BB_MOBILE_COMPACT_CHECK === "1") {
      assert.equal(result.includes("FROZEN-SOURCE-SENTINEL"), false)
      assert.ok(Buffer.byteLength(JSON.stringify(value.run)) < 512)
    }
    return value
  }
  const paused = await chat("paused")
  assert.equal(paused.run.paused, true)
  assert.equal(paused.run.queue.length, 1)
  assert.equal(report.providerRequests, 0)
  assert.equal((await call("runs.get", { sessionID: session.id })).queue[0].prompt.legacyParts[1].text, source)
  check("Paired phone reports a paused queue while the host retains the exact frozen source")
  await phone.getByRole("button", { name: "Chats", exact: true }).first().click()
  await phone.getByRole("button", { name: session.title, exact: true }).click()
  await phone.locator("#queue-status").getByRole("button", { name: "Resume queue", exact: true }).click()
  await phone.getByText("Resumed the preserved request.", { exact: true }).waitFor({ timeout: 45000 })
  for (let index = 0; index < 300; index++) {
    const run = await call("runs.get", { sessionID: session.id })
    if (!run.queue.length && !run.awaiting) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const resumed = await chat("completed")
  assert.equal(resumed.run.queue.length, 0)
  assert.equal(Boolean(resumed.run.awaiting), false)
  assert.equal(report.providerRequests, 1)
  assert.equal(report.frozenSourceReachedProvider, true)
  const saved = JSON.parse(await readFile(join(data, "chat-runs.json"), "utf8"))[session.id]
  assert.equal(saved.last.legacyParts[1].text, source)
  assert.equal(await phone.getByText("Resume probe", { exact: true }).count(), 1)
  assert.equal(await phone.getByText(source, { exact: true }).count(), 0)
  check("Phone Resume submits the preserved source once, clears waiting and keeps its durable host snapshot")
  assert.deepEqual(report.errors, [])
  check("Phone timeline stays compact with no renderer errors")
} catch (error) {
  report.failure = String(error)
  console.error(error)
  process.exitCode = 1
} finally {
  await writeFile(
    join(root, ".tools/qa/results", process.env.BB_MOBILE_STATUS_REPORT || "mobile-status-before.json"),
    JSON.stringify(report, null, 2),
  )
  await browser?.close()
  await app?.close()
  fixture.closeAllConnections()
  await new Promise((resolve) => fixture.close(resolve))
}
