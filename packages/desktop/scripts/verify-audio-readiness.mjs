import assert from "node:assert/strict"
import { randomUUID, createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { captureHidden } from "./qa-capture.mjs"

const root = resolve("../..")
const { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const profile = process.env.BB_QA_AUDIO_FRESH_PROFILE || join(root, ".tools/qa/ar-" + randomUUID().slice(0, 8))
const data = join(profile, "BitsBytesChat")
const hook = join(profile, "python-hook")
const results = join(root, ".tools/qa/results")
const name = process.env.BB_QA_REPORT || "audio-readiness"
const executablePath = process.env.BB_QA_EXECUTABLE
assert.ok(executablePath)
const report = {
  checks: [],
  errors: [],
  profile,
  paidRequests: false,
  physicalMicrophoneUsed: false,
  freshComponents: !process.env.BB_QA_AUDIO_FRESH_PROFILE,
  keyChecks: 0,
  audioRequests: 0,
  asarSHA256: createHash("sha256")
    .update(await readFile(join(dirname(executablePath), "resources/app.asar")))
    .digest("hex"),
}
let keyStatus = 200
let key = "bb-fixture-audio-key"
let holdKey = false
const heldKeys = []
const audioStatuses = []
const fixture = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, "Bearer " + key)
  if (req.method === "GET") {
    report.keyChecks++
    if (holdKey) {
      heldKeys.push(res)
      return
    }
    res
      .writeHead(keyStatus, { "content-type": "application/json" })
      .end(JSON.stringify({ data: { label: "Fixture audio" } }))
    return
  }
  let input = ""
  for await (const chunk of req) input += chunk
  const body = JSON.parse(input)
  assert.equal(body.model, "openai/gpt-4o-mini-transcribe")
  assert.equal(body.input_audio.format, "wav")
  assert.equal(Buffer.from(body.input_audio.data, "base64").subarray(0, 4).toString(), "RIFF")
  report.audioRequests++
  const status = audioStatuses.shift() || 200
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(
      JSON.stringify(
        status === 200 ? { text: "Synthetic native transcription recovered." } : { error: "Owned transient fixture" },
      ),
    )
})
await new Promise((done) => fixture.listen(0, "127.0.0.1", done))
const endpoint = `http://127.0.0.1:${fixture.address().port}`
await Promise.all([data, hook, results].map((p) => mkdir(p, { recursive: true })))
await writeFile(
  join(hook, "sitecustomize.py"),
  `import httpx, os
original = httpx.stream
def stream(method, url, **kwargs):
    if url == "https://openrouter.ai/api/v1/audio/transcriptions":
        if kwargs.get("headers", {}).get("Authorization") != "Bearer bb-fixture-audio-key":
            raise RuntimeError("Only the fixture key is allowed")
        url = os.environ["BB_QA_AUDIO_ENDPOINT"]
    return original(method, url, **kwargs)
httpx.stream = stream
import sounddevice, threading, array, time, math
def query_devices(device=None, kind=None):
    row = {"name": "Owned 48k stereo fixture", "max_input_channels": 2, "default_samplerate": 48000}
    return row if kind else [row]
def check_input_settings(**options):
    if options["samplerate"] != 48000 or options["channels"] != 2:
        raise sounddevice.PortAudioError("Unsupported fixture format")
class FixtureStream:
    def __init__(self, **options):
        self.options = options
        self.ending = threading.Event()
    def start(self):
        def capture():
            samples = array.array("h", [v for i in range(4800) for v in [int(8000 * math.sin(2 * math.pi * 440 * i / 48000))] * 2]).tobytes()
            while not self.ending.is_set():
                self.options["callback"](samples, 4800, None, None)
                time.sleep(0.1)
        self.thread = threading.Thread(target=capture, daemon=True)
        self.thread.start()
    def stop(self):
        self.ending.set()
        if hasattr(self, "thread"): self.thread.join(2)
    def close(self):
        self.stop()
sounddevice.query_devices = query_devices
sounddevice.check_input_settings = check_input_settings
sounddevice.RawInputStream = FixtureStream
`,
)
const audio = Buffer.alloc(44 + 16000 * 2)
audio.write("RIFF")
audio.writeUInt32LE(audio.length - 8, 4)
audio.write("WAVEfmt ", 8)
audio.writeUInt32LE(16, 16)
audio.writeUInt16LE(1, 20)
audio.writeUInt16LE(1, 22)
audio.writeUInt32LE(16000, 24)
audio.writeUInt32LE(32000, 28)
audio.writeUInt16LE(2, 32)
audio.writeUInt16LE(16, 34)
audio.write("data", 36)
audio.writeUInt32LE(audio.length - 44, 40)
const source = join(profile, "synthetic.wav")
await writeFile(source, audio)
const check = (label) => {
  report.checks.push(label)
  console.log("PASS", label)
}
let app, page
try {
  app = await _electron.launch({
    executablePath,
    env: {
      ...process.env,
      BB_QA_ISOLATED: "1",
      BB_QA_HIDDEN: "1",
      BB_QA_CAPTURE: "1",
      LOCALAPPDATA: profile,
      PYTHONPATH: hook,
      BB_QA_AUDIO_KEY_URL: endpoint + "/key",
      BB_QA_AUDIO_ENDPOINT: endpoint + "/transcribe",
    },
    timeout: 90000,
  })
  page = await app.firstWindow({ timeout: 120000 })
  page.on("pageerror", (e) => report.errors.push(e.message))
  await page.evaluate(() => window.api.awaitInitialization())
  await page.locator(".bb-org-sidebar").waitFor({ state: "attached", timeout: 90000 })
  const call = (method, args = {}) =>
    page.evaluate(({ method, args }) => window.api.bitsbytes.call(method, args), { method, args })
  if (!process.env.BB_QA_AUDIO_FRESH_PROFILE) {
    assert.equal((await call("state")).workerReady, false)
    await assert.rejects(call("audio.check"), /audioKey/)
    assert.equal(report.audioRequests, 0)
    check("A fresh profile reports missing components and a missing key before capturing or uploading audio")
  }
  await call("keys.save", { openrouter: "bb-fixture-audio-key" })
  const started = Date.now()
  console.log("Preparing owned cloud audio components; no user profile or microphone is used")
  const preparing = call("audio.check")
  const concurrent = call("audio.check")
  await Promise.all([preparing, concurrent])
  report.preparationMs = Date.now() - started
  assert.equal((await call("state")).workerReady, true)
  assert.equal((await call("state")).audioPreparing, false)
  assert.equal(report.audioRequests, 0)
  check("Concurrent first-use checks share a real bounded component preparation and become ready without manual repair")
  await call("settings.save", {
    engine: "openrouter",
    audioModel: "openai/gpt-4o-mini-transcribe",
    audioDiarization: false,
    microphone: null,
  })
  const job = await call("import", {
    path: source,
    title: "Fresh synthetic audio",
    engine: "openrouter",
    audioModel: "openai/gpt-4o-mini-transcribe",
    audioDiarization: false,
  })
  const result = await call("transcribe", { id: job.id })
  assert.equal(result.status, "transcribed")
  assert.equal(result.transcript.trim(), "Synthetic native transcription recovered.")
  assert.equal(report.audioRequests, 1)
  check("New components perform import, WAV preparation and real owned-worker transcription against a local provider")
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.webContents.setBackgroundThrottling(false)
    w.setContentSize(1080, 700)
    w.webContents.setZoomFactor(1)
  })
  await page.locator(".bb-org-new-chat").click()
  await page.locator("[contenteditable=true]").first().waitFor({ timeout: 60000 })
  const record = page.locator('[data-action="record-audio"]').first()
  report.composerGeometry = await page.locator('[data-action="record-audio"]').evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect()
      const ancestors = []
      for (let parent = node; parent && ancestors.length < 7; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        ancestors.push({
          tag: parent.tagName,
          class: parent.className,
          rect: parent.getBoundingClientRect().toJSON(),
          position: style.position,
          z: style.zIndex,
          display: style.display,
        })
      }
      return {
        rect: rect.toJSON(),
        overlay: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.outerHTML,
        ancestors,
      }
    }),
  )
  await captureHidden(app, page, join(results, name + "-before-record.png"))
  audioStatuses.push(503)
  await record.click()
  await page.locator('[data-action="attach-recording"]').first().waitFor()
  const captured = (await call("state")).jobs.find((j) => j.recording)
  assert.ok(captured)
  await page.waitForTimeout(1300)
  await page.locator('[data-action="attach-recording"]').first().click()
  const retry = page.locator('[data-action="retry-transcription"]').first()
  await retry.waitFor({ timeout: 30000 })
  const recovery = (await call("state")).jobs.find(
    (j) => j.id === captured.id && j.status === "error" && j.recording === false && j.chunks.length > 0,
  )
  assert.ok(recovery && recovery.chunks.length > 0 && !recovery.recording)
  report.recoveryJob = recovery.id
  await captureHidden(app, page, join(results, name + "-recovery.png"))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(780, 480))
  await page.waitForFunction(() => innerWidth === 780)
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const bounds = await page
    .locator(".bb-audio-recovery")
    .evaluate((n) => ({ rect: n.getBoundingClientRect().toJSON(), w: innerWidth, h: innerHeight }))
  report.recoveryGeometry = bounds
  assert.ok(
    bounds.rect.left >= 0 &&
      bounds.rect.right <= bounds.w + 1 &&
      bounds.rect.top >= 0 &&
      bounds.rect.bottom <= bounds.h + 1,
  )
  await captureHidden(app, page, join(results, name + "-narrow-recovery.png"))
  await retry.click()
  await retry.waitFor({ state: "hidden", timeout: 30000 })
  await page.getByText("transcript.txt", { exact: true }).first().waitFor({ timeout: 30000 })
  const recovered = (await call("state")).jobs.find((j) => j.id === recovery.id)
  assert.equal(recovered.status, "transcribed")
  assert.equal(recovered.transcript.trim(), "Synthetic native transcription recovered.")
  await page.getByText("transcript.txt", { exact: true }).first().waitFor()
  const controls = await record.boundingBox()
  assert.ok(controls && controls.y >= 0 && controls.y + controls.height <= (await page.evaluate(() => innerHeight)))
  assert.equal(report.audioRequests, 3)
  check(
    "48k stereo fixture capture resamples correctly, saves provider failure, and Retry attaches the recovered transcript",
  )
  await record.click()
  await page.locator('[data-action="cancel-recording"]').first().waitFor()
  await page.waitForTimeout(300)
  await page.locator('[data-action="cancel-recording"]').first().click()
  await record.waitFor()
  assert.equal(report.audioRequests, 3)
  check("Cancel retains owned audio without submitting or inserting another transcript")
  const beforeCancel = (await call("state")).jobs.length
  key = "bb-fixture-audio-replacement"
  await call("keys.save", { openrouter: key })
  holdKey = true
  await record.click()
  await page.locator('[data-action="cancel-recording"]').first().waitFor()
  await page.locator('[data-action="cancel-recording"]').first().click()
  holdKey = false
  heldKeys
    .splice(0)
    .forEach((res) =>
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ data: { label: "Fixture audio" } })),
    )
  await record.waitFor()
  await page.waitForTimeout(700)
  assert.equal((await call("state")).jobs.length, beforeCancel)
  assert.equal(report.audioRequests, 3)
  check("Cancel during connection preparation prevents late microphone capture or provider submission")
  key = "bb-fixture-rejected-key"
  keyStatus = 401
  await call("keys.save", { openrouter: key })
  await assert.rejects(call("record.start"), /audioConnectionRejected/)
  assert.equal((await call("state")).jobs.length, beforeCancel)
  assert.equal(report.audioRequests, 3)
  check("A rejected replacement key fails before microphone capture and makes no audio request")
  const saved = await call("state")
  assert.equal(JSON.stringify(saved).includes("bb-fixture-audio-key"), false)
  const path = join(results, name + "-ready.png")
  await captureHidden(app, page, path)
  report.screenshot = path
  assert.deepEqual(report.errors, [])
} catch (error) {
  report.failure = error.stack
  if (page) await captureHidden(app, page, join(results, name + "-failure.png")).catch(() => {})
  throw error
} finally {
  if (app) await app.close()
  fixture.closeAllConnections()
  fixture.close()
  await writeFile(join(results, name + ".json"), JSON.stringify(report, null, 2))
}
