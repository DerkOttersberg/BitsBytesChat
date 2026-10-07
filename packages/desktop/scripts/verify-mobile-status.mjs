import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { createServer } from "node:http"
import { mkdir, readFile, writeFile, symlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { bbt } from "../src/bitsbytes/copy.ts"

const root = resolve("../..")
const { _electron, chromium } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const profile = join(root, ".tools/qa/mobile-status-" + randomUUID()),
  data = join(profile, "BitsBytesChat")
const report = { checks: [], errors: [], responseBytes: [], providerRequests: 0, frozenSourceReachedProvider: false }
const slow = {
  entered: Promise.withResolvers(),
  release: Promise.withResolvers(),
  disconnected: Promise.withResolvers(),
}
async function bounded(promise, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(label)), 20000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
const source = "FROZEN-SOURCE-SENTINEL\n" + "Nederlandse bron 🌿 ".repeat(6000)
const fixture = createServer(async (request, response) => {
  const bytes = []
  for await (const chunk of request) bytes.push(chunk)
  const body = Buffer.concat(bytes).toString("utf8")
  report.providerRequests++
  const input = JSON.parse(body)
  report.frozenSourceReachedProvider ||= (input.messages ?? []).some((message) =>
    (typeof message.content === "string"
      ? [message.content]
      : (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text)
    ).some((text) => text.includes(source)),
  )
  if (body.includes("slow-stop-marker")) {
    response.on("close", () => slow.disconnected.resolve())
    slow.entered.resolve()
    await slow.release.promise
    if (response.destroyed) return
  }
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
  const chat = async (label, id = session.id) => {
    const result = await phone.evaluate(async (id) => {
      const response = await fetch("/api", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "chat", args: { sessionID: id } }),
      })
      if (!response.ok) throw Error("Chat HTTP " + response.status)
      return response.text()
    }, id)
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
  if (process.env.BB_PHONE_GRID === "1") {
    const path = join(data, "Dense.csv"),
      rows = Array.from({ length: 80 }, (_, row) =>
        Array.from({ length: 100 }, (_, column) => `ROW ${row} COL ${column} ` + "é🌿".repeat(120) + " END"),
      ),
      text = rows.map((row) => row.join(",")).join("\r\n")
    await writeFile(path, text)
    const artifact = await call("artifact.publish", { path, sessionID: session.id })
    await phone.locator("#files-button").click()
    await phone.locator("#preview-content .artifact-card").filter({ hasText: "Dense.csv" }).click()
    const preview = phone.locator("#preview-content"),
      table = preview.locator("table"),
      next = preview.getByRole("button", { name: "Next", exact: true }),
      previous = preview.getByRole("button", { name: "Previous", exact: true })
    await table.getByText(rows[0][0], { exact: true }).waitFor()
    const offsets = []
    let offset = 0
    while (offset < rows.length) {
      const count = await table.locator("tr").count()
      assert.ok(count > 0 && count < rows.length)
      assert.equal(await table.locator("th").first().innerText(), String(offset + 1))
      assert.equal(await table.locator("tr").first().locator("td").first().innerText(), rows[offset][0])
      assert.equal(await table.locator("tr").last().locator("td").first().innerText(), rows[offset + count - 1][0])
      offsets.push(offset)
      offset += count
      if (offset < rows.length) {
        await next.click()
        await table.getByText(rows[offset][0], { exact: true }).waitFor()
      }
    }
    assert.equal(await next.isDisabled(), true)
    for (const offset of offsets.slice(0, -1).reverse()) {
      await previous.click()
      await table.getByText(rows[offset][0], { exact: true }).waitFor()
    }
    const downloaded = await phone
      .context()
      .request.get(new URL("/file/" + artifact.id + "?revision=1", phone.url()).href)
    assert.equal(downloaded.status(), 200)
    assert.equal((await downloaded.body()).toString("utf8"), text)
    assert.equal(await readFile(artifact.source, "utf8"), text)
    await phone.locator("#preview-close").click()
    report.gridOffsets = offsets
    check("Paired phone pages through a dense saved CSV without skipped rows and downloads its exact complete revision")
  }
  if (process.env.BB_PHONE_STATUS_CHECK !== "stop") {
    await call("runs.admit", {
      prompt: {
        ...prompt,
        id: prompt.id + "c",
        text: "Invalid source probe",
        legacyParts: [{ type: "file", url: "bitsbytes://invalid/context" }],
      },
    })
    for (let index = 0; index < 100; index++) {
      if ((await call("runs.get", { sessionID: session.id })).error) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const error = await chat("missing-source-error")
    assert.equal(error.run.error, bbt("bb.error.invalidRequest"))
    const failed = await call("runs.get", { sessionID: session.id })
    assert.match(failed.error, /bb\.error\.invalidRequest/)
    assert.equal(failed.queue[0].status, "failed")
    assert.equal(failed.queue[0].sentAt, undefined)
    await phone
      .locator("#queue-status")
      .getByText(bbt("bb.error.invalidRequest"), { exact: true })
      .waitFor({ timeout: 15000 })
    assert.equal(report.providerRequests, 1)
    check("Phone shows recovery copy for a proven unsent failure; the host retains its source and admits no prompt")
  }
  if (process.env.BB_PHONE_STATUS_CHECK !== "copy") {
    await phone.locator("#menu-button").click()
    await phone.locator("#drawer-body").getByRole("button", { name: "New chat", exact: true }).click()
    await phone.waitForFunction(
      (previous) => localStorage.getItem("bb.session") && localStorage.getItem("bb.session") !== previous,
      session.id,
    )
    const stopID = await phone.evaluate(() => localStorage.getItem("bb.session"))
    await phone.locator("#model").selectOption(JSON.stringify({ providerID: "status-qa", modelID: "fixture" }))
    await phone.locator("#prompt").fill("slow-stop-marker")
    await phone.locator("#send").click()
    await bounded(slow.entered.promise, "The Stop fixture did not reach the provider")
    for (let index = 0; index < 100; index++) {
      if (!(await call("runs.get", { sessionID: stopID })).queue.length) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const active = await call("runs.get", { sessionID: stopID })
    assert.equal(active.queue.length, 0)
    assert.equal(active.awaiting, true)
    const stopResponse = phone.waitForResponse(
      (response) => response.url().endsWith("/api") && response.request().postDataJSON()?.method === "stop",
    )
    await phone.locator("#stop").click()
    const acknowledgement = await stopResponse
    assert.ok(acknowledgement.ok())
    const stopBody = await acknowledgement.text()
    report.stopResponse = { status: acknowledgement.status(), bytes: Buffer.byteLength(stopBody) }
    assert.doesNotThrow(() => JSON.parse(stopBody))
    await bounded(slow.disconnected.promise, "Stop did not disconnect its stalled provider request")
    const stopped = await chat("stopped", stopID)
    report.stopHost = {
      paused: stopped.run.paused,
      awaiting: stopped.run.awaiting,
      queued: stopped.run.queue.length,
      busy: Boolean(stopped.status && stopped.status.type !== "idle"),
    }
    assert.equal(stopped.run.paused, true)
    assert.equal(stopped.run.awaiting, false)
    assert.equal(report.stopHost.busy, false)
    await phone.locator("#stop").waitFor({ state: "hidden", timeout: 15000 })
    assert.equal(await phone.locator("#notice").isVisible(), false)
    assert.equal(report.providerRequests, 2)
    check(
      "Phone Stop aborts its active provider, clears host waiting after acknowledgement and restores the idle composer",
    )
  }
  assert.deepEqual(report.errors, [])
  check("Phone timeline stays compact with no renderer errors")
} catch (error) {
  report.failure = String(error)
  console.error(error)
  process.exitCode = 1
} finally {
  slow.release.resolve()
  await writeFile(
    join(root, ".tools/qa/results", process.env.BB_MOBILE_STATUS_REPORT || "mobile-status-before.json"),
    JSON.stringify(report, null, 2),
  )
  await browser?.close()
  await app?.close()
  fixture.closeAllConnections()
  await new Promise((resolve) => fixture.close(resolve))
}
