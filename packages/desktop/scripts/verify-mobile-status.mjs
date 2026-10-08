import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { createServer } from "node:http"
import { mkdir, readFile, rmdir, writeFile, symlink } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { randomUUID } from "node:crypto"
import { bbt } from "../src/bitsbytes/copy.ts"

const root = resolve("../..")
const { _electron, chromium } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const profile = join(root, ".tools/qa/mobile-status-" + randomUUID()),
  data = join(profile, "BitsBytesChat")
const storageDevice = process.env.BB_STOP_STORAGE_FAILURE,
  observing = process.env.BB_STOP_STORAGE_OBSERVE === "1"
const backgroundStorage = process.env.BB_RUN_STORAGE_FAILURE === "1",
  observeBackground = process.env.BB_RUN_STORAGE_OBSERVE === "1"
const admissionStorage = process.env.BB_ADMISSION_STORAGE_FAILURE === "1"
assert.ok([storageDevice, backgroundStorage, admissionStorage].filter(Boolean).length <= 1, "Run one owned storage fault at a time")
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
const storageSource = "QUEUE-STORAGE-RECOVERY\n" + source
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
  if (backgroundStorage)
    report.storageSourceReachedProvider ||= (input.messages ?? []).some((message) =>
      (typeof message.content === "string"
        ? [message.content]
        : (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text)
      ).some((text) => text.includes(storageSource)),
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
    env: { ...process.env, BB_QA_ISOLATED: "1", BB_QA_HIDDEN: "1", LOCALAPPDATA: profile },
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
  // Ordinary Send intentionally releases a user Stop. Hold this first request
  // through a real owned journal failure instead: recovery pauses still require
  // explicit Resume, and the complete frozen source must remain available.
  const admissionTemporary = join(data, "chat-runs.json.tmp")
  assert.ok(resolve(admissionTemporary).startsWith(resolve(profile) + sep))
  await mkdir(admissionTemporary)
  await assert.rejects(call("runs.admit", { prompt }))
  await rmdir(admissionTemporary)
  if (admissionStorage) {
    // Cross multiple real host polling intervals after restoring storage.
    await new Promise(resolve => setTimeout(resolve, 3500))
    const run = await call("runs.get", { sessionID: session.id })
    report.rejectedAdmission = { providerRequests: report.providerRequests, paused: run.paused, awaiting: run.awaiting, queued: run.queue.length, error: run.error }
    console.log("OBSERVATION", JSON.stringify(report.rejectedAdmission))
    assert.equal(report.providerRequests, 0)
    assert.equal(run.paused, true)
    assert.equal(run.awaiting, false)
    assert.ok(run.error.includes("chat-runs.json.tmp"))
    for (const key of Object.keys(prompt)) assert.deepEqual(run.queue[0].prompt[key], prompt[key])
    check("A rejected admission stays paused across host polling after storage recovers and cannot silently reach the provider")
  }
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
    if (backgroundStorage) {
      const queued = {
        ...prompt,
        sessionID: stopID,
        id: prompt.id.slice(0, -1) + "c",
        text: storageSource,
        legacyParts: [
          { type: "text", text: "Recover the saved queued source" },
          { type: "text", text: storageSource, synthetic: true },
        ],
      }
      await call("runs.admit", { prompt: queued })
      const temporary = join(data, "chat-runs.json.tmp")
      assert.ok(resolve(temporary).startsWith(resolve(profile) + sep))
      await mkdir(temporary)
      slow.release.resolve()
      for (let index = 0; index < 200; index++) {
        const value = await call("runs.get", { sessionID: stopID })
        if (value.error) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const value = await call("runs.get", { sessionID: stopID })
      report.backgroundStorage = {
        paused: value.paused,
        awaiting: value.awaiting,
        status: value.queue[0]?.status,
        sentAt: value.queue[0]?.sentAt,
        error: value.error,
        appExit: app.process().exitCode,
      }
      assert.equal(report.providerRequests, 2)
      assert.equal(value.queue[0].prompt.legacyParts[1].text, storageSource)
      assert.equal(value.error.includes("chat-runs.json.tmp"), true)
      if (!observeBackground) {
        assert.equal(value.paused, true)
        assert.equal(value.awaiting, false)
        assert.ok(["pending", "failed"].includes(value.queue[0].status))
        assert.equal(value.queue[0].sentAt, undefined)
        assert.equal(app.process().exitCode, null)
        await phone.locator("#queue-status").filter({ hasText: "chat-runs.json.tmp" }).waitFor({ timeout: 15000 })
      }
      await rmdir(temporary)
      if (!observeBackground) {
        await call("runs.resume", { sessionID: stopID })
        for (let index = 0; index < 200; index++) {
          const current = await call("runs.get", { sessionID: stopID })
          if (!current.queue.length && !current.awaiting) break
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        const recovered = await call("runs.get", { sessionID: stopID })
        assert.equal(recovered.queue.length, 0)
        assert.equal(recovered.awaiting, false)
        assert.equal(report.storageSourceReachedProvider, true)
        assert.equal(report.providerRequests, 3)
        assert.equal(
          JSON.parse(await readFile(join(data, "chat-runs.json"), "utf8"))[stopID].last.legacyParts[1].text,
          storageSource,
        )
        check(
          "Background journal failure pauses visibly before dispatch; explicit Resume delivers the exact saved source once",
        )
      }
    } else {
      const temporary = join(data, "chat-runs.json.tmp")
      if (storageDevice) {
        assert.ok(resolve(temporary).startsWith(resolve(profile) + sep))
        for (let index = 0; index < 100; index++) {
          const saved = JSON.parse(await readFile(join(data, "chat-runs.json"), "utf8"))[stopID]
          if (saved && !saved.queue.length) break
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        await mkdir(temporary)
      }
      if (storageDevice === "desktop") {
        await desktop.evaluate((detail) => window.dispatchEvent(new CustomEvent("bitsbytes:session", { detail })), {
          directory: active.last.directory,
          sessionID: stopID,
        })
        await desktop
          .locator(`.bb-workspace-chat[data-bb-chat="${stopID}"]`)
          .getByRole("button", { name: "Stop", exact: true })
          .click()
        if (!observing) await desktop.getByText("Request failed", { exact: true }).waitFor({ timeout: 15000 })
      } else {
        const stopResponse = phone.waitForResponse(
          (response) => response.url().endsWith("/api") && response.request().postDataJSON()?.method === "stop",
        )
        await phone.locator("#stop").click()
        const acknowledgement = await stopResponse,
          stopBody = await acknowledgement.text()
        assert.equal(acknowledgement.ok(), !storageDevice)
        report.stopResponse = { status: acknowledgement.status(), bytes: Buffer.byteLength(stopBody) }
        assert.doesNotThrow(() => JSON.parse(stopBody))
      }
      if (storageDevice && observing) {
        const disconnected = await Promise.race([
          slow.disconnected.promise.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
        ])
        const stopped = await chat("stop-storage-observation", stopID)
        report.stopStorage = {
          device: storageDevice,
          disconnected,
          paused: stopped.run.paused,
          awaiting: stopped.run.awaiting,
          busy: Boolean(stopped.status && stopped.status.type !== "idle"),
        }
        console.log("OBSERVATION", JSON.stringify(report.stopStorage))
        await rmdir(temporary)
      } else {
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
        if (storageDevice) {
          await rmdir(temporary)
          await call("runs.stop", { sessionID: stopID })
          assert.equal(JSON.parse(await readFile(join(data, "chat-runs.json"), "utf8"))[stopID].paused, true)
          if (storageDevice === "phone") assert.equal(await phone.locator("#notice").isVisible(), true)
        } else assert.equal(await phone.locator("#notice").isVisible(), false)
        assert.equal(report.providerRequests, 2)
        check(
          storageDevice
            ? "Stop interrupts its active provider despite a journal failure, exposes the save error and recovers persistence"
            : "Phone Stop aborts its active provider, clears host waiting after acknowledgement and restores the idle composer",
        )
      }
    }
  }
  if (!observing && !observeBackground) {
    assert.deepEqual(report.errors, [])
    check("Phone timeline stays compact with no renderer errors")
  }
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
