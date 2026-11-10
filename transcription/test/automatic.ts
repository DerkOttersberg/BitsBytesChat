import assert from "node:assert/strict"
import { _electron, expect } from "@playwright/test"
import { build } from "esbuild"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = await mkdtemp(path.join(os.tmpdir(), "bb-auto-speakers-"))
await mkdir("test-results", { recursive: true })
await build({ entryPoints: ["test/auto-main.ts"], outfile: "test-results/auto-main.mjs", platform: "node", format: "esm", bundle: true, packages: "external", target: "node22", tsconfig: "tsconfig.json" })
const fake = path.join(root, "microphone.wav")
const pcm = Buffer.alloc(32000 * 6); const header = Buffer.alloc(44)
header.write("RIFF"); header.writeUInt32LE(pcm.length + 36, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40)
await writeFile(fake, Buffer.concat([header, pcm]))
async function launch() {
  const electron = await _electron.launch({ args: [path.resolve("test-results/auto-main.mjs"), "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${fake}`], env: { ...process.env, BITSBYTES_TEST_DATA: path.join(root, "data") } })
  const page = await electron.firstWindow(); await page.waitForSelector("aside")
  return { electron, page }
}
let { electron, page } = await launch()
try {
  const quickToggle = page.getByRole("switch", { name: "Separate speakers", exact: true })
  await expect(quickToggle).toHaveAttribute("aria-checked", "false")
  await quickToggle.click()
  await expect(page.getByRole("switch", { name: "Separate speakers", exact: true })).toHaveAttribute("aria-checked", "true")
  const concurrent = await page.evaluate(() => Promise.all([
    window.api.saveSettings({ model: "elevenlabs/scribe-v2", language: "", microphone: "", speakers: false, key: "synthetic-test-key" }),
    window.api.setSpeakers(true)
  ]))
  assert.ok(concurrent.every(reply => reply.ok))
  const settings = await page.evaluate(() => window.api.snapshot())
  assert.ok(settings.ok)
  if (settings.ok) { assert.equal(settings.value.settings.hasKey, true); assert.equal(settings.value.settings.speakers, true) }
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await page.locator("#key").fill("synthetic-test-key")
  await page.getByRole("button", { name: "Save settings", exact: true }).click()
  await expect(page.locator("#toast")).toHaveText("Settings saved")
  await page.getByRole("button", { name: "New recording", exact: true }).click()
  await expect(page.locator(".status.recording")).toBeVisible()
  await expect(page.getByRole("switch", { name: "Separate speakers", exact: true })).toBeDisabled()
  await expect.poll(async () => { const state = await page.evaluate(() => window.api.snapshot()); return state.ok ? state.value.recordings[0].duration : 0 }).toBeGreaterThanOrEqual(2)
  await page.getByRole("button", { name: "Finish recording", exact: true }).click()
  await expect(page.locator(".status.complete")).toBeVisible({ timeout: 15000 })
  await expect(page.locator(".speaker-turn")).toHaveCount(3)
  await expect(page.locator(".speaker-label")).toHaveText(["Speaker 1", "Speaker 2", "Speaker 1"])
  await page.getByRole("button", { name: "Copy transcript", exact: true }).click()
  assert.equal(await electron.evaluate(({ clipboard }) => clipboard.readText()), "Speaker 1: Hello there.\n\nSpeaker 2: Hi.\n\nSpeaker 1: Again.")
  await page.screenshot({ path: path.resolve("test-results/08-speaker-transcript.png") })
  await page.getByRole("switch", { name: "Separate speakers", exact: true }).click()
  await expect(page.getByRole("switch", { name: "Separate speakers", exact: true })).toHaveAttribute("aria-checked", "false")
  await page.getByRole("button", { name: "New recording", exact: true }).click()
  await expect(page.locator(".status.recording")).toBeVisible()
  await expect.poll(async () => { const state = await page.evaluate(() => window.api.snapshot()); return state.ok ? state.value.recordings[0].duration : 0 }).toBeGreaterThanOrEqual(1)
  await page.getByRole("button", { name: "Save and close recorder", exact: true }).click()
  await expect(page.locator(".status.complete")).toBeVisible()
  await expect(page.locator(".transcript-text")).toContainText("Automatically transcribed")
  await expect(page.locator(".dictation-bar")).toHaveCount(0)
  // Imports also start only after their original has been copied and flushed.
  await electron.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, fake)
  await page.getByRole("button", { name: "Import audio", exact: true }).click()
  await expect(page.locator(".recording-item")).toHaveCount(3)
  await expect(page.locator(".status.complete")).toBeVisible()
  const history = JSON.parse(await readFile(path.join(root, "data", "requests.json"), "utf8"))
  assert.equal(history.length, 3)
  assert.deepEqual(history.map((row: { saved: boolean }) => row.saved), [true, true, true])
  assert.deepEqual(history.map((row: { diarize: boolean }) => row.diarize), [true, false, false])
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await page.locator("#model").fill("openai/whisper-1")
  await expect(page.locator(".speaker-field").getByRole("switch")).toBeDisabled()
  await electron.close()
  ;({ electron, page } = await launch())
  await expect(page.locator(".recording-item")).toHaveCount(3)
  await page.locator(".recording-item").last().click()
  await expect(page.locator(".speaker-turn")).toHaveCount(3)
  const after = JSON.parse(await readFile(path.join(root, "data", "requests.json"), "utf8"))
  assert.equal(after.length, 3)
  console.log(JSON.stringify({ passed: true, autoTranscription: true, speakerToggle: true, serializedSettings: true, imports: true, restartWithoutUpload: true, root }))
} finally { await electron.close().catch(() => undefined) }
