import { createRequire } from "node:module"
import { createServer } from "node:http"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import assert from "node:assert/strict"
import { mobileCopy } from "../src/bitsbytes/mobile-copy.ts"

const root = resolve("../.."), assets = join(root, "packages/desktop/resources/bitsbytes/mobile")
const { chromium } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const report = { checks: [], errors: [], uploads: 0, sends: 0, samples: [] }
const check = (name) => { report.checks.push(name); console.log("PASS", name) }
const uploads = [], chats = [{ id: "ses_original", title: "Original chat" }, { id: "ses_other", title: "Other chat" }]
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
let lostFinish = false
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1")
    if (req.method === "GET" && ["/", "/app.js", "/audio.js", "/style.css", "/copy.js"].includes(url.pathname)) {
      res.setHeader("content-type", url.pathname === "/" ? "text/html" : url.pathname.endsWith("css") ? "text/css" : "text/javascript")
      res.end(url.pathname === "/copy.js" ? "window.BB_COPY=" + JSON.stringify(mobileCopy) : await readFile(join(assets, url.pathname === "/" ? "index.html" : url.pathname.slice(1))))
      return
    }
    const chunks = []; for await (const bytes of req) chunks.push(bytes)
    const bytes = Buffer.concat(chunks), input = req.method === "POST" ? JSON.parse(bytes.toString() || "{}") : {}
    let value
    if (url.pathname === "/api") {
      if (input.method === "overview") value = { chats, skills: [], models: [], engine: "parakeet" }
      if (input.method === "chat") value = { messages: [], artifacts: [], permissions: [], questions: [], status: { type: "idle" }, access: { mode: "ask" }, run: { queue: [], awaiting: false, paused: false } }
      if (input.method === "artifacts") value = []
      if (input.method === "transcript-reference") value = { revision: 1 }
      if (input.method === "transcript") value = { text: "Volledig Nederlands testtranscript." }
      if (input.method === "send") { report.sends++; value = {} }
    }
    if (url.pathname === "/uploads") value = uploads.map(({ bytes, ...row }) => row)
    if (url.pathname === "/upload" && req.method === "POST") {
      value = uploads.find((row) => row.fingerprint === input.fingerprint && row.sessionID === input.sessionID)
      if (!value) { value = { ...input, id: randomUUID(), status: "uploading", chunks: [], bytes: Buffer.alloc(0) }; uploads.push(value); report.uploads++ }
    }
    if (url.pathname.startsWith("/upload/")) {
      const row = uploads.find((row) => row.id === url.pathname.split("/")[2])
      assert.ok(row)
      if (req.method === "PUT") {
        assert.ok(bytes.length <= 4 * 1024 ** 2)
        const offset = Number(url.searchParams.get("offset")), old = row.chunks.find((chunk) => chunk.offset === offset)
        if (old) assert.equal(old.hash, digest(bytes))
        else { assert.equal(offset, row.bytes.length); row.bytes = Buffer.concat([row.bytes, bytes]); row.chunks.push({ offset, length: bytes.length, hash: digest(bytes) }) }
      }
      if (url.pathname.endsWith("/finish")) {
        assert.equal(row.bytes.length, row.size)
        row.status = "ready"; row.jobID = row.id.replaceAll("-", "")
        // Return an unusable acknowledgement after the server committed. A raw socket
        // close can be transparently retried by Chromium before fetch sees a failure.
        if (lostFinish) { lostFinish = false; res.writeHead(200, { "content-type": "application/json" }).end("{"); return }
      }
      value = row
    }
    if (value === undefined) { res.writeHead(404).end(JSON.stringify({ error: "Fixture route not implemented" })); return }
    const { bytes: omitted, ...output } = Array.isArray(value) ? {} : value
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(value) ? value : output))
  } catch (error) { report.errors.push(error.message); res.writeHead(500).end(JSON.stringify({ error: error.message })) }
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const origin = "http://127.0.0.1:" + server.address().port
const browser = await chromium.launch({ headless: true, channel: "msedge", args: ["--use-fake-device-for-media-stream"] })
const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
await context.grantPermissions(["microphone"], { origin })
const page = await context.newPage()
page.on("pageerror", (error) => report.errors.push(error.message))
await page.addInitScript(() => { if (!localStorage.getItem("bb.session")) localStorage.setItem("bb.session", "ses_original") })
const records = () => page.evaluate(async () => {
  const { PhoneAudio } = await import("/audio.js")
  return new PhoneAudio({ copy: window.BB_COPY }).records()
})
const waitRecords = async (status, predicate = () => true) => {
  for (let i = 0; i < 100; i++) { const row = (await records()).find((row) => row.status === status && predicate(row)); if (row) return row; await page.waitForTimeout(100) }
  throw Error("Recording did not reach " + status)
}
try {
  const began = Date.now()
  await page.goto(origin)
  await page.locator("#app").waitFor({ state: "visible" })
  report.bootMs = Date.now() - began
  assert.equal(await page.getByRole("button", { name: "Record audio", exact: true }).count(), 1)
  assert.equal(await page.getByRole("button", { name: "Choose audio", exact: true }).count(), 1)
  assert.equal(await page.evaluate(() => performance.getEntriesByType("resource").some((row) => row.name.endsWith("/pdf.mjs"))), false)
  check("Microphone and upload are separate visible composer controls; PDF code is deferred")
  await page.locator("#prompt").fill("Preserve my draft")
  await page.locator("#record-button").click()
  await page.getByText("Recording", { exact: true }).waitFor()
  await page.waitForTimeout(2400)
  const otherTab = await context.newPage()
  await otherTab.goto(origin); await otherTab.locator("#app").waitFor({ state: "visible" })
  assert.ok((await records()).some((row) => row.status === "recording"))
  await otherTab.locator("#record-button").click()
  await otherTab.getByText(mobileCopy.audioOtherTab, { exact: true }).waitFor()
  await otherTab.close()
  check("A second tab cannot replace or recover an active microphone recording")
  await page.getByRole("button", { name: "Pause recording", exact: true }).click()
  await page.getByText("Paused", { exact: true }).waitFor()
  const paused = await page.locator("#recording-time").textContent()
  await page.waitForTimeout(1100)
  assert.equal(await page.locator("#recording-time").textContent(), paused)
  await page.getByRole("button", { name: "Resume recording", exact: true }).click()
  await page.getByText("Recording", { exact: true }).waitFor()
  await page.waitForTimeout(1100)
  await page.getByRole("button", { name: "Cancel recording", exact: true }).click()
  const cancelled = await waitRecords("cancelled")
  assert.ok(cancelled.size > 0); assert.ok(cancelled.count >= 2)
  assert.equal(report.uploads, 0); assert.equal(report.sends, 0)
  assert.equal(await page.locator("#prompt").inputValue(), "Preserve my draft")
  assert.equal(await page.locator("#attachments .source-chip").count(), 0)
  check("Actual MediaRecorder pause/resume and cancel retain durable audio without uploading, attaching or sending")
  await page.reload(); await page.locator("#app").waitFor({ state: "visible" })
  assert.ok((await records()).some((row) => row.id === cancelled.id && row.size === cancelled.size))
  await page.locator("#menu-button").click(); await page.getByRole("button", { name: "Audio uploads", exact: true }).click()
  await page.getByText("Recordings on this phone", { exact: true }).waitFor()
  check("Saved phone audio survives reload and appears with recovery/download/delete actions")
  await page.locator("#menu-button").click()
  await page.locator("#record-button").click(); await page.getByText("Recording", { exact: true }).waitFor()
  await page.waitForTimeout(2200)
  await page.locator("#menu-button").click(); await page.getByRole("button", { name: "Chats", exact: true }).last().click()
  await page.getByRole("button", { name: "Other chat", exact: true }).click()
  await page.locator("#prompt").fill("Independent other draft")
  lostFinish = true
  await page.getByRole("button", { name: "Finish and attach transcript", exact: true }).click()
  const unfinished = await waitRecords("finish", (row) => !!row.uploadID)
  assert.ok(unfinished.uploadID); assert.equal(unfinished.chat, "ses_original")
  assert.equal(report.uploads, 1)
  await page.reload(); await page.locator("#app").waitFor({ state: "visible" })
  await page.locator("#menu-button").click(); await page.getByRole("button", { name: "Audio uploads", exact: true }).click()
  await page.locator("section .list-row").filter({ hasText: unfinished.name }).getByRole("button", { name: "Finish and attach transcript", exact: true }).click()
  const attached = await waitRecords("attached")
  assert.equal(attached.id, unfinished.id); assert.equal(report.uploads, 1); assert.equal(report.sends, 0)
  assert.equal(await page.locator("#prompt").inputValue(), "Independent other draft")
  assert.equal(await page.locator("#attachments .source-chip").count(), 0)
  const original = await page.evaluate(() => JSON.parse(localStorage.getItem("bb.draft.ses_original")))
  assert.equal(original.text, "Preserve my draft"); assert.equal(original.transcripts.length, 1)
  check("Lost final acknowledgement retries the same upload and attaches only to the original chat draft")
  await writeFile(join(root, ".tools/qa/results/phone-short" + (uploads[0].name.endsWith("m4a") ? ".m4a" : ".webm")), uploads[0].bytes)
  await page.getByRole("button", { name: "Chats", exact: true }).last().click(); await page.getByRole("button", { name: "Original chat", exact: true }).click()
  assert.equal(await page.locator("#attachments .source-chip").count(), 1)
  assert.equal(await page.locator("#prompt").inputValue(), "Preserve my draft")
  assert.equal(await page.locator("#messages").textContent().then((text) => text.includes("Volledig Nederlands")), false)
  check("Transcript remains a compact attachment and never auto-sends or expands into the composer")
  await page.screenshot({ path: join(root, ".tools/qa/results/phone-audio-033.png") })
  const cdp = await context.newCDPSession(page)
  const { targetInfo } = await cdp.send("Target.getTargetInfo")
  await cdp.send("Browser.setPermission", { permission: { name: "microphone" }, setting: "denied", origin, browserContextId: targetInfo.browserContextId })
  assert.equal(await page.evaluate(async () => (await navigator.permissions.query({ name: "microphone" })).state), "denied")
  await page.locator("#record-button").click()
  await page.getByText(mobileCopy.audioPermission, { exact: true }).waitFor()
  assert.equal(await page.locator("#record-button").isEnabled(), true)
  check("Denied microphone permission has actionable feedback and leaves the composer usable")
  await cdp.send("Browser.setPermission", { permission: { name: "microphone" }, setting: "granted", origin, browserContextId: targetInfo.browserContextId })
  const interruptedTab = await context.newPage()
  await interruptedTab.goto(origin); await interruptedTab.locator("#app").waitFor({ state: "visible" })
  await interruptedTab.locator("#record-button").click()
  await interruptedTab.getByText("Recording", { exact: true }).waitFor(); await interruptedTab.waitForTimeout(6400)
  const live = (await records()).find((row) => row.status === "recording")
  assert.ok(live?.size > 0)
  await interruptedTab.close()
  await page.reload(); await page.locator("#app").waitFor({ state: "visible" })
  const recovered = await waitRecords("interrupted", (row) => row.id === live.id)
  assert.equal(recovered.size, live.size)
  assert.equal(report.sends, 0)
  const interruptedBytes = await page.evaluate(async (row) => {
    const { PhoneAudio } = await import("/audio.js")
    const file = await new PhoneAudio({ copy: window.BB_COPY }).file(row)
    return Array.from(new Uint8Array(await file.arrayBuffer()))
  }, recovered)
  await writeFile(join(root, ".tools/qa/results/phone-interrupted" + (recovered.mime.includes("mp4") ? ".m4a" : ".webm")), Buffer.from(interruptedBytes))
  check("Closing the capture tab releases its lock and recovers persisted chunks on reopening")
  await page.evaluate(() => localStorage.setItem("bb.draft.ses_original", "null"))
  await page.reload(); await page.locator("#app").waitFor({ state: "visible" })
  assert.equal(await page.locator("#record-button").isEnabled(), true)
  assert.equal(await page.evaluate(() => localStorage.getItem("bb.draft.ses_original.recovery")), "null")
  check("A malformed phone draft remains recoverable without breaking the composer")
  const soak = Number(process.env.BB_AUDIO_SOAK_MINUTES || 0)
  if (soak > 0) {
    await cdp.send("Browser.setPermission", { permission: { name: "microphone" }, setting: "granted", origin, browserContextId: targetInfo.browserContextId })
    await page.locator("#record-button").click(); await page.getByText("Recording", { exact: true }).waitFor()
    const started = Date.now()
    console.log("SOAK started", new Date(started).toISOString(), "minutes", soak)
    let offline = false
    while (Date.now() - started < soak * 60000) {
      await page.waitForTimeout(10000)
      const duration = Date.now() - started
      const recording = (await records()).find((row) => row.status === "recording")
      assert.ok(recording, "Capture ended unexpectedly during the endurance test")
      report.samples.push({ elapsedMs: duration, count: recording.count, bytes: recording.size,
        ...(await page.evaluate(async () => ({ heapBytes: performance.memory?.usedJSHeapSize, storage: await navigator.storage.estimate(), timer: document.querySelector("#recording-time").textContent }))),
      })
      if (duration > 20000 && duration < 45000 && !offline) { await context.setOffline(true); offline = true; console.log("SOAK offline capture") }
      if (duration > 45000 && offline) { await context.setOffline(false); offline = false; console.log("SOAK reconnected") }
      if (report.samples.length % 6 === 0) {
        console.log("SOAK", JSON.stringify(report.samples.at(-1)))
        await writeFile(join(root, ".tools/qa/results/phone-audio-soak-live.json"), JSON.stringify(report, null, 2))
      }
    }
    await page.getByRole("button", { name: "Cancel recording", exact: true }).click()
    const saved = await waitRecords("cancelled", (row) => row.created >= started - 1000)
    assert.ok(saved.seconds >= Math.floor(soak * 60) - 3)
    // MediaRecorder timeslices are not an exact clock; compare duration independently.
    assert.ok(saved.count > 1)
    await page.reload(); await page.locator("#app").waitFor({ state: "visible" })
    assert.ok((await records()).some((row) => row.id === saved.id && row.size === saved.size))
    await page.locator("#menu-button").click(); await page.getByRole("button", { name: "Audio uploads", exact: true }).click()
    const download = page.waitForEvent("download")
    await page.locator("section .list-row").filter({ hasText: saved.name }).getByRole("button", { name: "Download", exact: true }).click()
    const file = await download
    const target = join(root, ".tools/qa/results/phone-endurance" + (saved.mime.includes("mp4") ? ".m4a" : ".webm"))
    await file.saveAs(target)
    report.endurance = { seconds: saved.seconds, count: saved.count, bytes: saved.size, mime: saved.mime, path: target }
    check(`${soak}-minute actual browser capture, offline recovery, reload and complete audio download`)
  }
  assert.deepEqual(report.errors, [])
} catch (error) { report.errors.push(error.stack); throw error }
finally {
  await mkdir(join(root, ".tools/qa/results"), { recursive: true })
  await writeFile(join(root, ".tools/qa/results/" + (process.env.BB_AUDIO_SOAK_MINUTES ? "phone-audio-soak-033.json" : "phone-audio-033.json")), JSON.stringify(report, null, 2))
  if (uploads[0]?.bytes.length) await writeFile(join(root, ".tools/qa/results/phone-short" + (uploads[0].name.endsWith("m4a") ? ".m4a" : ".webm")), uploads[0].bytes)
  await browser.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve))
}
