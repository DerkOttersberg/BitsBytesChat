import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { constants, setPriority } from "node:os"
import { join, resolve } from "node:path"

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
  assert.equal(bytes.subarray(0, 4).toString(), "RIFF")
  assert.equal(body.input_audio.format, "wav")
  assert.equal(body.response_format, "json")
  report.requests.push({ model: body.model, language: body.language || "", wavBytes: bytes.length })
  if (hold)
    await new Promise((done) => {
      release = done
    })
  const status = outcomes.shift() || 200
  response.writeHead(status, { "content-type": "application/json" })
  response.end(
    JSON.stringify(status === 200 ? { text: "Fictional local transcription." } : { error: "Local rate-limit fixture" }),
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
  assert.equal(original.settings.engine, "parakeet")
  assert.equal(original.settings.intakeFolder, "retained-fixture-folder")
  assert.equal(original.settings.audioModel, "openai/whisper-large-v3-turbo")
  assert.equal(original.settings.audioLanguage, "")
  assert.equal(original.jobs.find((job) => job.id === "legacy-fixture").transcript, "Saved historical text.")
  check("Retired cloud selection migrates to local; historical transcript and recording identity survive")
  await page.locator(".bb-org-account").getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.locator(".settings-v2-dialog")
  await settings.getByRole("searchbox", { name: "Search settings", exact: true }).fill("Audio transcription")
  await settings.locator(".settings-v2-search-result").filter({ hasText: "Audio transcription" }).first().click()
  const engine = settings.locator('[data-setting-key="audio-engine"] select')
  await engine.selectOption("openrouter")
  assert.deepEqual(await engine.locator("option").evaluateAll((nodes) => nodes.map((node) => node.value)), [
    "parakeet",
    "whisper",
    "openrouter",
  ])
  const model = settings.getByRole("combobox", { name: "Transcription model", exact: true })
  await poll(
    () => model.locator('option[value="openai/gpt-4o-mini-transcribe"]').count(),
    (count) => count === 1,
    "actual public transcription catalogue",
  )
  await model.selectOption("openai/gpt-4o-mini-transcribe")
  await settings.getByRole("textbox", { name: "Audio language (optional)", exact: true }).fill("nl")
  const key = settings.locator('[data-setting-key="audio-openrouter-key"] input')
  await key.fill("bb-fixture-audio-key")
  await settings.getByRole("button", { name: "Save keys securely", exact: true }).click()
  await poll(
    () => key.inputValue(),
    (value) => value === "",
    "masked saved connection",
  )
  assert.equal(await key.getAttribute("type"), "password")
  await settings.getByRole("button", { name: "Save", exact: true }).click()
  const selected = await poll(
    () => call("state"),
    (state) => state.settings.engine === "openrouter",
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
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused()),
    ),
    false,
  )
  await app.close()
  app = undefined
  const restored = await launch()
  assert.equal(restored.settings.audioModel, "openai/gpt-4o-mini-transcribe")
  assert.equal(restored.settings.audioLanguage, "nl")
  assert.equal(restored.openrouterSet, true)
  assert.equal(restored.jobs.find((row) => row.id === job.id).transcript, completed.transcript)
  assert.equal(restored.jobs.find((row) => row.id === "legacy-fixture").transcript, "Saved historical text.")
  assert.equal(report.requests.length, before + 1)
  check(
    "Restart restores preferences, encrypted connection and old/new transcripts without repeating provider requests",
  )
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
