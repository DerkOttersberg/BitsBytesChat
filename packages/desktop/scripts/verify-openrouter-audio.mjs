import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { constants, setPriority } from "node:os"
import { join, resolve } from "node:path"
import { captureHidden } from "./qa-capture.mjs"

// Own isolated windows and a test Python environment. No real keys, microphone or paid requests.
setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
const root = resolve("../..")
const { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const profile = join(root, ".tools/qa/openrouter-audio-" + randomUUID())
const data = join(profile, "BitsBytesChat")
const python = join(profile, "python")
const results = join(root, ".tools/qa/results")
const name = process.env.BB_QA_REPORT || "openrouter-audio"
const runtime = process.env.BB_AUDIO_RUNTIME || join(root, ".tools/qa/openrouter-runtime")
const report = { checks: [], errors: [], requests: [], profile, syntheticTranscription: true, paidRequests: false }
let outcomes = [],
  hold = false,
  release
const fixture = createServer(async (request, response) => {
  let payload = ""
  for await (const part of request) payload += part
  const body = JSON.parse(payload)
  assert.equal(request.method, "POST")
  assert.equal(request.headers.authorization, "Bearer bb-fixture-audio-key")
  const bytes = Buffer.from(body.input_audio.data, "base64")
  const diarization = body.provider?.options?.elevenlabs?.diarize === true
  assert.equal(body.input_audio.format, diarization ? "mp3" : "wav")
  assert.equal(body.response_format, diarization ? "verbose_json" : "json")
  if (!diarization) assert.equal(bytes.subarray(0, 4).toString(), "RIFF")
  if (diarization) assert.deepEqual(body.timestamp_granularities, ["word"])
  report.requests.push({ model: body.model, language: body.language || "", audioBytes: bytes.length, diarization })
  if (hold)
    await new Promise((done) => {
      release = done
    })
  const status = outcomes.shift() || 200
  response.writeHead(status, { "content-type": "application/json" })
  response.end(
    JSON.stringify(status === 200 ? diarization ? { text: "Hallo Derk. Hoi! Nogmaals.", words: [
      { word: "Hallo", start: 0, end: 1, speaker: 0 },
      { word: "Derk.", start: 1, end: 2, speaker: 0 },
      { word: "Hoi!", start: 28, end: 29, speaker: 1 },
      { word: "Nogmaals.", start: 30, end: 31, speaker: 0 },
    ] } : { text: "Fictional local transcription." } : { error: "Local rate-limit fixture" }),
  )
})
await new Promise((done) => fixture.listen(0, "127.0.0.1", done))
const endpoint = `http://127.0.0.1:${fixture.address().port}/audio/transcriptions`
await Promise.all([data, python, results, join(data, "runtime")].map((path) => mkdir(path, { recursive: true })))
await symlink(runtime, join(data, "runtime/worker"), "junction")
await writeFile(
  join(python, "sitecustomize.py"),
  `
import httpx, os
original = httpx.stream
def stream(method, url, **kwargs):
    if url == "https://openrouter.ai/api/v1/audio/transcriptions":
        if kwargs.get("headers", {}).get("Authorization") != "Bearer bb-fixture-audio-key":
            raise RuntimeError("Only the isolated fixture key is allowed")
        url = os.environ["BB_QA_AUDIO_ENDPOINT"]
    return original(method, url, **kwargs)
httpx.stream = stream
`,
)
await writeFile(
  join(data, "settings.json"),
  JSON.stringify({
    engine: "groq",
    audioModel: 7,
    audioLanguage: "damaged-language",
    intakeFolder: "retained-fixture-folder",
    microphone: null,
    provider: "chatgpt",
    model: "",
  }),
)
const legacy = join(data, "recordings/legacy-fixture")
await mkdir(legacy, { recursive: true })
await writeFile(
  join(legacy, "job.json"),
  JSON.stringify({
    id: "legacy-fixture",
    title: "Historical recording fixture",
    engine: "groq",
    created: 1,
    updated: 1,
    duration: 1,
    status: "transcribed",
    chunks: [],
    segments: [],
    transcript: "Saved historical text.",
    skill: "",
    error: "",
    recording: false,
  }),
)
const recording = join(profile, "synthetic.wav")
const audio = Buffer.alloc(44 + 16000 * 2 * 31)
audio.write("RIFF", 0)
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
await writeFile(recording, audio)
const check = (label) => {
  report.checks.push(label)
  console.log("PASS", label)
}
const poll = async (read, accept, label) => {
  for (let index = 0; index < 200; index++) {
    const value = await read()
    if (accept(value)) return value
    await new Promise((done) => setTimeout(done, 100))
  }
  throw Error("Timed out: " + label)
}
let app, page
const call = (method, args = {}) =>
  page.evaluate(({ method, args }) => window.api.bitsbytes.call(method, args), { method, args })
const launch = async () => {
  app = await _electron.launch({
    executablePath:
      process.env.BB_QA_EXECUTABLE || join(root, ".tools/qa/openrouter-audio-package/win-unpacked/BitsBytesChat.exe"),
    ...(process.env.BB_QA_MAIN ? { args: [process.env.BB_QA_MAIN] } : {}),
    env: {
      ...process.env,
      BB_QA_ISOLATED: "1",
      BB_QA_HIDDEN: "1",
      BB_QA_CAPTURE: "1",
      LOCALAPPDATA: profile,
      PYTHONPATH: python,
      BB_QA_AUDIO_ENDPOINT: endpoint,
    },
    timeout: 90000,
  })
  page = await app.firstWindow()
  page.setDefaultTimeout(30000)
  page.on("pageerror", (error) => report.errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.webContents.setBackgroundThrottling(false)
    window.setContentSize(1380, 900)
  })
  await page.locator(".bb-org-sidebar").waitFor({ timeout: 90000 })
  await page.evaluate(() => window.api.awaitInitialization())
  return call("state")
}
try {
  const original = await launch()
  assert.equal(original.workerReady, true)
  assert.equal(original.settings.engine, "openrouter")
  assert.equal(original.settings.intakeFolder, "retained-fixture-folder")
  assert.equal(original.settings.audioModel, "elevenlabs/scribe-v2")
  assert.equal(original.settings.audioDiarization, true)
  assert.equal(original.settings.audioLanguage, "")
  assert.equal(original.jobs.find((job) => job.id === "legacy-fixture").transcript, "Saved historical text.")
  assert.equal(report.requests.length, 0)
  check("Retired/local preferences migrate to OpenRouter without sending historical audio; saved transcripts survive")
  await page.locator(".bb-org-account").getByRole("button", { name: "Settings", exact: true }).click()
  let settings = page.locator(".settings-v2-dialog")
  await settings.getByRole("searchbox", { name: "Search settings", exact: true }).fill("Separate speakers")
  await settings.locator(".settings-v2-search-result").filter({ hasText: "Separate speakers" }).first().click()
  assert.equal(await settings.locator('[data-setting-key="audio-engine"], [data-setting-key="audio-acceleration"]').count(), 0)
  assert.equal(await settings.getByRole("button", { name: /Download Parakeet|Download Whisper/ }).count(), 0)
  let separation = settings.getByRole("checkbox", { name: "Separate speakers", exact: true })
  assert.equal(await separation.isChecked(), true)
  let model = settings.getByRole("combobox", { name: "Transcription model", exact: true })
  await poll(
    () => model.locator('option[value="openai/gpt-4o-mini-transcribe"]').count(),
    (count) => count === 1,
    "actual public transcription catalogue",
  )
  assert.equal(await model.inputValue(), "elevenlabs/scribe-v2")
  await model.selectOption("openai/gpt-4o-mini-transcribe")
  await poll(() => call("state"), state => state.settings.audioModel === "openai/gpt-4o-mini-transcribe", "model autosave without Save")
  assert.equal(await separation.isEnabled(), false)
  assert.equal(await separation.isChecked(), false)
  await settings.getByRole("textbox", { name: "Audio language (optional)", exact: true }).fill("nl")
  assert.equal(await settings.locator('[data-setting-key="audio-openrouter-key"], input[type="password"]').count(), 0)
  await call("keys.save", { openrouter: "bb-fixture-audio-key" })
  await settings.getByRole("button", { name: "Save", exact: true }).click()
  const selected = await poll(
    () => call("state"),
    (state) => state.settings.engine === "openrouter" && state.settings.audioModel === "openai/gpt-4o-mini-transcribe" && state.settings.audioLanguage === "nl",
    "saved audio preferences",
  )
  assert.equal(selected.settings.audioModel, "openai/gpt-4o-mini-transcribe")
  assert.equal(selected.settings.audioLanguage, "nl")
  assert.equal(selected.settings.provider, original.settings.provider)
  assert.equal(selected.settings.model, original.settings.model)
  assert.equal(selected.openrouterSet, true)
  assert.equal(JSON.stringify(selected).includes("bb-fixture-audio-key"), false)
  assert.equal((await readFile(join(data, "credentials.bin"))).includes(Buffer.from("bb-fixture-audio-key")), false)
  check(
    "Audio settings discover only real transcription models, save language, reuse encrypted OpenRouter keys and preserve chat selection",
  )
  const configuration = JSON.parse(await readFile(join(data, "config/opencode/opencode.json"), "utf8"))
  const bridge = configuration.mcp["bitsbytes-local"].environment
  const credential = async (name, args = {}) => {
    const response = await fetch(bridge.BITSBYTES_TOOL_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + bridge.BITSBYTES_TOOL_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ name, arguments: args }),
    })
    assert.equal(response.ok, true)
    return response.json()
  }
  await credential("credentials.v2.create", {
    id: "cred_audio_fixture",
    integrationID: "openrouter",
    label: "Fixture connection",
    value: { type: "key", key: "bb-initial-v2-fixture", metadata: { fixture: true } },
  })
  await call("keys.save", { openrouter: "bb-fixture-audio-key" })
  await credential("credentials.v2.import", { records: [{ id: "cred_stale_import", integrationID: "openrouter", label: "Stale database copy", value: { type: "key", key: "stale-key" } }] })
  assert.equal((await credential("credentials.v2.all")).filter(row => row.integrationID === "openrouter").length, 1)
  const native = (await credential("credentials.v2.all")).find((row) => row.id === "cred_audio_fixture")
  assert.equal(native.value.key, "bb-fixture-audio-key")
  assert.equal(native.value.metadata.fixture, true)
  assert.equal(native.label, "Fixture connection")
  check("V2 connections share the Audio key while replacement preserves credential identity and metadata")
  await page.keyboard.press("Escape")
  await page.locator(".bb-org-sidebar").getByRole("button", { name: "Recordings", exact: true }).click()
  assert.equal(
    await page
      .locator(".bb-page")
      .filter({ hasText: "Recordings" })
      .innerText()
      .then((text) => /groq/i.test(text)),
    false,
  )
  const job = await call("import", { path: recording, title: "OpenRouter native fixture", engine: "openrouter" })
  outcomes = [200, 429]
  const failed = await call("transcribe", { id: job.id }).then(
    () => "unexpected success",
    (error) => error.message,
  )
  assert.match(failed, /audioQuota/)
  const partial = await call("job", { id: job.id })
  assert.deepEqual(
    partial.chunks.map((chunk) => chunk.done),
    [true, false],
  )
  assert.equal(report.requests.length, 2)
  const card = page.locator(".bb-job").filter({ hasText: "OpenRouter native fixture" })
  await card.getByRole("button", { name: "Resume transcription", exact: true }).click()
  const completed = await poll(
    () => call("job", { id: job.id }),
    (job) => job.status === "transcribed",
    "manual chunk retry",
  )
  assert.equal(report.requests.length, 3)
  assert.equal(completed.transcript, "Fictional local transcription.\nFictional local transcription.")
  assert.ok(
    report.requests.every((request) => request.model === "openai/gpt-4o-mini-transcribe" && request.language === "nl"),
  )
  // Completing Resume adds the recovered transcript to the preserved chat draft.
  await page.locator(".bb-org-sidebar").getByRole("button", { name: "Recordings", exact: true }).click()
  await card.getByRole("button", { name: "Transcript", exact: true }).click()
  await page.getByText(completed.transcript, { exact: true }).waitFor()
  await page.locator(".bb-modal header button").click()
  check(
    "Real desktop host, decoder, worker subprocess and recording UI retain completed chunks and resume only the failed chunk",
  )
  const cancelled = await call("import", { path: recording, title: "Cancellation fixture", engine: "openrouter" })
  const before = report.requests.length
  hold = true
  const pending = call("transcribe", { id: cancelled.id })
  await poll(
    () => report.requests.length,
    (length) => length > before,
    "owned cloud request",
  )
  const started = performance.now()
  await call("transcribe.cancel", { id: cancelled.id })
  const stopped = await pending
  assert.equal(stopped.status, "cancelled")
  assert.equal(stopped.chunks[0].done, false)
  assert.ok(performance.now() - started < 2500)
  hold = false
  release?.()
  check("Cancel stops the owned cloud request promptly and leaves uncommitted audio recoverable")
  await page.locator(".bb-org-account").getByRole("button", { name: "Settings", exact: true }).click()
  await settings.getByRole("searchbox", { name: "Search settings", exact: true }).fill("Separate speakers")
  await settings.locator(".settings-v2-search-result").filter({ hasText: "Separate speakers" }).first().click()
  await model.selectOption("elevenlabs/scribe-v2")
  await poll(() => call("state"), state => state.settings.audioModel === "elevenlabs/scribe-v2", "Scribe autosave without Save")
  assert.equal(await separation.isEnabled(), true)
  await separation.uncheck()
  await settings.getByRole("button", { name: "Save", exact: true }).click()
  await poll(() => call("state"), state => state.settings.audioDiarization === false, "speaker toggle off")
  await separation.check()
  await settings.getByRole("button", { name: "Save", exact: true }).click()
  await poll(() => call("state"), state => state.settings.audioDiarization === true, "speaker toggle on")
  await captureHidden(app, page, join(results, name + "-audio.png"))
  await page.keyboard.press("Escape")
  check("Minimal Audio settings expose a searchable Scribe speaker toggle; unsupported models disable it and saves persist")
  const labelled = await call("import", { path: recording, title: "Speaker separation fixture", engine: "openrouter" })
  const speakerRequests = report.requests.length
  const diarized = await call("transcribe", { id: labelled.id })
  assert.equal(report.requests.length, speakerRequests + 1)
  assert.equal(report.requests.at(-1).diarization, true)
  assert.deepEqual(diarized.segments.map(turn => turn.speaker), ["speaker_0", "speaker_1", "speaker_0"])
  assert.equal(diarized.transcript, "Speaker 1: Hallo Derk.\nSpeaker 2: Hoi!\nSpeaker 1: Nogmaals.")
  const originalReference = await call("transcript.snapshot", { id: labelled.id })
  const originalSource = join(data, "recordings", labelled.id, "sources", `${originalReference.revision}.txt`)
  await page.locator(".bb-org-sidebar").getByRole("button", { name: "Recordings", exact: true }).click()
  await page.locator(".bb-job").filter({ hasText: "Speaker separation fixture" }).getByRole("button", { name: "Transcript", exact: true }).click()
  await page.locator(".bb-modal pre").getByText(diarized.transcript, { exact: true }).waitFor()
  await page.locator(".bb-speaker-names summary").click()
  await page.getByRole("textbox", { name: "Speaker 1", exact: true }).fill("Derk")
  await page.locator(".bb-modal").getByRole("button", { name: "Save", exact: true }).click()
  const named = "Derk: Hallo Derk.\nSpeaker 2: Hoi!\nDerk: Nogmaals."
  await page.locator(".bb-modal pre").getByText(named, { exact: true }).waitFor()
  assert.equal(report.requests.length, speakerRequests + 1)
  assert.equal(await readFile(originalSource, "utf8"), diarized.transcript)
  assert.notEqual((await call("transcript.snapshot", { id: labelled.id })).revision, originalReference.revision)
  await captureHidden(app, page, join(results, name + "-speakers.png"))
  await page.getByRole("button", { name: "Close transcript", exact: true }).click()
  check("One actual encoded recording yields persistent speaker turns; renaming updates text without API calls or changing old attachments")
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused()),
    ),
    false,
  )
  await app.close()
  app = undefined
  const restored = await launch()
  settings = page.locator(".settings-v2-dialog")
  separation = settings.getByRole("checkbox", { name: "Separate speakers", exact: true })
  model = settings.getByRole("combobox", { name: "Transcription model", exact: true })
  assert.equal(restored.settings.audioModel, "elevenlabs/scribe-v2")
  assert.equal(restored.settings.audioLanguage, "nl")
  assert.equal(restored.settings.audioDiarization, true)
  assert.equal(restored.openrouterSet, true)
  assert.equal(restored.jobs.find((row) => row.id === job.id).transcript, completed.transcript)
  assert.equal(restored.jobs.find((row) => row.id === "legacy-fixture").transcript, "Saved historical text.")
  assert.equal(restored.jobs.find(row => row.id === labelled.id).transcript, named)
  assert.equal(report.requests.length, speakerRequests + 1)
  check(
    "Restart restores preferences, encrypted connection and old/new transcripts without repeating provider requests",
  )
  await page.locator(".bb-org-account").getByRole("button", { name: "Settings", exact: true }).click()
  await settings.getByRole("searchbox", { name: "Search settings", exact: true }).fill("Separate speakers")
  await settings.locator(".settings-v2-search-result").filter({ hasText: "Separate speakers" }).first().click()
  await poll(() => model.isEnabled(), value => value, "catalogue after restart")
  assert.equal(await model.inputValue(), "elevenlabs/scribe-v2")
  await model.selectOption("openai/gpt-4o-mini-transcribe")
  await poll(() => call("state"), state => state.settings.audioModel === "openai/gpt-4o-mini-transcribe", "second model autosave")
  await model.selectOption("elevenlabs/scribe-v2")
  await poll(() => call("state"), state => state.settings.audioModel === "elevenlabs/scribe-v2", "restored Scribe autosave")
  // Close/reopen the page: asynchronous options must not replace the native selection.
  await settings.getByRole("tab", { name: "Models", exact: true }).click()
  await settings.getByRole("tab", { name: "Audio", exact: true }).click()
  await poll(() => model.isEnabled(), value => value, "reopened catalogue")
  assert.equal(await model.inputValue(), "elevenlabs/scribe-v2")
  await page.keyboard.press("Escape")
  const afterRestart = await call("import", { path: recording, title: "Saved Scribe selection", engine: "openrouter" })
  const lastRequest = report.requests.length
  await call("transcribe", { id: afterRestart.id })
  assert.equal(report.requests.length, lastRequest + 1)
  assert.equal(report.requests.at(-1).model, "elevenlabs/scribe-v2")
  assert.equal(report.requests.at(-1).diarization, true)
  check("Model changes persist without Save; reopening and restart display Scribe and the actual worker request uses that exact model")
  assert.deepEqual(report.errors, [])
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused()),
    ),
    false,
  )
} catch (error) {
  report.failure = error.stack || String(error)
  throw error
} finally {
  release?.()
  await app?.close()
  fixture.closeAllConnections()
  await new Promise((done) => fixture.close(done))
  await writeFile(join(results, name + ".json"), JSON.stringify(report, null, 2))
}
