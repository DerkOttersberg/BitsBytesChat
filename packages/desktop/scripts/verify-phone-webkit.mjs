// Windows WebKit checks are useful browser coverage, not a physical iPhone test.
import { createRequire } from "node:module"
import { createServer } from "node:http"
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import assert from "node:assert/strict"
import { mobileCopy } from "../src/bitsbytes/mobile-copy.ts"

const root = resolve("../.."), assets = join(root, "packages/desktop/resources/bitsbytes/mobile")
const { webkit, devices } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const report = { checks: [], errors: [], uploads: 0, sends: 0 }
const rows = [], check = label => { report.checks.push(label); console.log("PASS", label) }
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost")
    if (request.method === "GET" && ["/", "/app.js", "/audio.js", "/style.css", "/copy.js"].includes(url.pathname)) {
      response.setHeader("content-type", url.pathname === "/" ? "text/html" : url.pathname.endsWith("css") ? "text/css" : "text/javascript")
      response.end(url.pathname === "/copy.js" ? "window.BB_COPY=" + JSON.stringify(mobileCopy) : await readFile(join(assets, url.pathname === "/" ? "index.html" : url.pathname.slice(1))))
      return
    }
    const chunks = []; for await (const bytes of request) chunks.push(bytes)
    const bytes = Buffer.concat(chunks), input = request.method === "POST" ? JSON.parse(bytes.toString() || "{}") : {}
    let result = {}
    if (url.pathname === "/api") {
      if (input.method === "overview") result = { chats: [{ id: "ses_webkit", title: "WebKit QA" }], skills: [], models: [], engine: "parakeet" }
      if (input.method === "chat") result = { messages: [], artifacts: [], permissions: [], questions: [], status: { type: "idle" }, access: { mode: "ask" }, run: { queue: [], awaiting: false, paused: false } }
      if (input.method === "artifacts") result = []
      if (input.method === "transcript-reference") result = { revision: 1 }
      if (input.method === "send") report.sends++
    }
    if (url.pathname === "/uploads") result = rows
    if (url.pathname === "/upload" && request.method === "POST") {
      result = { ...input, id: randomUUID(), offset: 0, chunks: [], status: "uploading" }; rows.push(result); report.uploads++
    }
    if (url.pathname.startsWith("/upload/")) {
      const row = rows.find(row => row.id === url.pathname.split("/")[2]); assert.ok(row)
      if (request.method === "PUT") {
        assert.equal(Number(url.searchParams.get("offset")), row.offset)
        row.chunks.push({ offset: row.offset, length: bytes.length, hash: createHash("sha256").update(bytes).digest("hex") })
        row.offset += bytes.length
      }
      if (url.pathname.endsWith("/finish")) { assert.equal(row.offset, row.size); row.status = "ready"; row.jobID = row.id.replaceAll("-", "") }
      result = row
    }
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify(result))
  } catch (error) { report.errors.push(error.message); response.writeHead(500).end("{}") }
})
await new Promise(done => server.listen(0, "127.0.0.1", done))
const browser = await webkit.launch({ headless: true, ...(process.env.BB_WEBKIT_EXECUTABLE ? { executablePath: process.env.BB_WEBKIT_EXECUTABLE } : {}) })
const context = await browser.newContext({ ...devices["iPhone 13"] }), page = await context.newPage()
await context.addInitScript(() => {
  localStorage.setItem("bb.session", "ses_webkit")
  // Supply a synthetic tone to the real WebKit MediaRecorder; no ambient audio.
  if (!navigator.mediaDevices) return
  navigator.mediaDevices.getUserMedia = async () => {
    const audio = new AudioContext(), source = audio.createOscillator(), gain = audio.createGain(), output = audio.createMediaStreamDestination()
    source.frequency.value = 440; gain.gain.value = .02; source.connect(gain).connect(output); source.start(); await audio.resume()
    return output.stream
  }
})
page.on("pageerror", error => report.errors.push(error.message))
const records = () => page.evaluate(async () => new (await import("/audio.js")).PhoneAudio({ copy: window.BB_COPY }).records())
try {
  await page.goto("http://127.0.0.1:" + server.address().port)
  await page.locator("#app").waitFor({ state: "visible" })
  assert.equal(await page.getByRole("button", { name: "Record audio", exact: true }).count(), 1)
  assert.equal(await page.getByRole("button", { name: "Choose audio", exact: true }).count(), 1)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  report.capabilities = await page.evaluate(() => ({ mediaRecorder: typeof MediaRecorder !== "undefined", mp4: typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/mp4"), webLocks: Boolean(navigator.locks) }))
  check("Windows WebKit phone layout exposes microphone and upload controls without horizontal overflow")
  await page.locator("#prompt").fill("Retain this WebKit draft")
  await page.locator("#record-button").click()
  if (report.capabilities.mediaRecorder) {
    await page.getByText("Recording", { exact: true }).waitFor()
    await page.waitForTimeout(4200)
    await page.getByRole("button", { name: "Pause recording", exact: true }).click()
    await page.getByText("Paused", { exact: true }).waitFor()
    await page.getByRole("button", { name: "Resume recording", exact: true }).click()
    await page.waitForTimeout(3200)
    await page.getByRole("button", { name: "Cancel recording", exact: true }).click()
    await page.waitForFunction(async () => (await new (await import("/audio.js")).PhoneAudio({ copy: window.BB_COPY }).records()).some(row => row.status === "cancelled"))
    const recording = (await records()).find(row => row.status === "cancelled")
    assert.ok(recording.size > 0); assert.equal(report.uploads, 0); assert.equal(report.sends, 0)
    assert.equal(await page.locator("#prompt").inputValue(), "Retain this WebKit draft")
    await page.reload(); await page.locator("#app").waitFor({ state: "visible" })
    assert.equal((await records()).find(row => row.id === recording.id).size, recording.size)
    const bytes = await page.evaluate(async row => Array.from(new Uint8Array(await (await new (await import("/audio.js")).PhoneAudio({ copy: window.BB_COPY }).file(row)).arrayBuffer())), recording)
    const target = join(root, ".tools/qa/results/phone-webkit" + (recording.mime.includes("mp4") ? ".m4a" : ".webm"))
    await writeFile(target, Buffer.from(bytes)); report.recording = { ...recording, path: target }
    check("Actual WebKit recording supports pause/resume, cancellation and durable reload without sending or uploading")
    await page.locator("#menu-button").click(); await page.getByRole("button", { name: "Audio uploads", exact: true }).click()
    await page.locator("section .list-row").filter({ hasText: recording.name }).getByRole("button", { name: "Finish and attach", exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll("#attachments .source-chip").length === 1)
    assert.equal(report.uploads, 1); assert.equal(report.sends, 0)
    assert.equal(await page.locator("#prompt").inputValue(), "Retain this WebKit draft")
    check("Finishing recovered WebKit audio creates one compact attachment and keeps Send separate")
  } else {
    await page.getByText(mobileCopy.audioUnavailable, { exact: true }).waitFor()
    check("Unavailable Windows WebKit recording gives readable feedback while retaining audio upload")
    await page.locator("#audio-file").setInputFiles(join(root, ".tools/qa/results/phone-short.m4a"))
    await page.locator("#drawer-body").getByRole("button", { name: mobileCopy.attach, exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll("#attachments .source-chip").length === 1)
    assert.equal(report.uploads, 1); assert.equal(report.sends, 0)
    assert.equal(await page.locator("#prompt").inputValue(), "Retain this WebKit draft")
    check("Windows WebKit file upload creates one compact attachment and preserves the unsent draft")
  }
  await page.screenshot({ path: join(root, ".tools/qa/results/phone-webkit-033.png") })
  assert.deepEqual(report.errors, [])
} catch (error) { report.errors.push(error.stack); throw error }
finally {
  await writeFile(join(root, ".tools/qa/results/phone-webkit-033.json"), JSON.stringify(report, null, 2))
  await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(done))
}
