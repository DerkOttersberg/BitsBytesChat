import { _electron, expect } from "@playwright/test"
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile, spawn } from "node:child_process"
import { createRequire } from "node:module"
import { promisify } from "node:util"
import { Library } from "../src/main/storage.js"

const root = await mkdtemp(path.join(os.tmpdir(), "bb-transcription-desktop-"))
const captures = path.resolve("test-results")
await mkdir(captures, { recursive: true })
const fake = path.join(root, "microphone.wav")
const header = Buffer.alloc(44); const pcm = Buffer.alloc(16000 * 2 * 10)
header.write("RIFF"); header.writeUInt32LE(pcm.length + 36, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40)
for (let index = 0; index < pcm.length / 2; index++) pcm.writeInt16LE(Math.sin(index * Math.PI * 2 * 220 / 16000) * 4000, index * 2)
await writeFile(fake, Buffer.concat([header, pcm]))
const executablePath = process.env.BITSBYTES_TEST_EXECUTABLE
async function launch() {
  const electron = await _electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ["."]), "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${fake}`], env: { ...process.env, BITSBYTES_TEST_DATA: path.join(root, "data") } })
  const page = await electron.firstWindow(); await page.waitForSelector("aside")
  page.on("pageerror", error => { throw error })
  return { electron, page }
}
let { electron, page } = await launch()
await page.screenshot({ path: path.join(captures, "01-empty.png") })
await expect(page.getByText("No recordings", { exact: true })).toBeVisible()
await expect(page.locator("main > .ci-decoration")).toHaveCount(1)
await expect(page.locator("body")).toHaveCSS("font-synthesis", "none")
await page.getByRole("button", { name: "Settings", exact: true }).click()
await page.locator("#language").fill("nl")
await page.getByRole("button", { name: "Save settings", exact: true }).click()
await expect(page.locator("#toast")).toHaveText("Settings saved")
await page.screenshot({ path: path.join(captures, "02-settings.png") })
await page.getByRole("button", { name: "New recording", exact: true }).click()
await expect(page.locator(".status.recording")).toBeVisible({ timeout: 15000 })
await expect(page.locator("meter, .ci-progress")).toHaveCount(0)
await expect(page.locator(".dictation-bar canvas")).toBeVisible()
await expect.poll(async () => { const reply = await page.evaluate(() => window.api.snapshot()); return reply.ok ? reply.value.recordings[0]?.duration : 0 }).toBeGreaterThanOrEqual(2)
await page.screenshot({ path: path.join(captures, "00-recording-waveform.png") })
await page.getByRole("button", { name: "Finish recording", exact: true }).first().click()
await expect(page.locator(".status.error")).toBeVisible()
await expect(page.locator(".notice")).toContainText("Save an OpenRouter API key")
const first = await page.evaluate(() => window.api.snapshot())
if (!first.ok) throw new Error("snapshot failed")
const id = first.value.recordings[0].id
await page.getByRole("button", { name: "Listen to recording", exact: true }).click()
await expect.poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.readyState)).toBeGreaterThanOrEqual(2)
await page.getByRole("button", { name: "Resume transcription", exact: true }).click()
await expect(page.locator("#toast")).toContainText("Save an OpenRouter API key")
await page.screenshot({ path: path.join(captures, "03-saved.png") })
// Force-kill our owned process while capture is active; reopen must recover the PCM.
await page.getByRole("button", { name: "New recording", exact: true }).click()
await expect(page.locator(".status.recording")).toBeVisible()
await expect.poll(async () => { const reply = await page.evaluate(() => window.api.snapshot()); return reply.ok ? reply.value.recordings[0]?.duration : 0 }).toBeGreaterThanOrEqual(2)
const mainPid = await electron.evaluate(() => process.pid)
await promisify(execFile)("taskkill", ["/PID", String(mainPid), "/T", "/F"])
;({ electron, page } = await launch())
await expect(page.locator(".status.interrupted")).toBeVisible()
await expect(page.locator(".recording-item")).toHaveCount(2)
await page.screenshot({ path: path.join(captures, "04-recovered.png") })
// Commit synthetic test transcript through the production persistence layer; verify UI/clipboard.
await electron.close()
const library = new Library(path.join(root, "data")); await library.initialize()
await library.savePart(id, 0, "A stable, simple place for your conversations.\n\nThis transcript was saved to disk, and remains available after reopening the app.")
const row = library.get(id); row.status = "complete"; row.error = ""; await library.save(row)
;({ electron, page } = await launch())
await page.locator(".recording-item").nth(1).click()
await expect(page.locator(".transcript-text")).toContainText("remains available after reopening")
await page.getByRole("button", { name: "Copy transcript", exact: true }).click()
const clipboard = await electron.evaluate(({ clipboard }) => clipboard.readText())
if (clipboard !== row.transcript) throw new Error("clipboard mismatch")
await page.screenshot({ path: path.join(captures, "05-transcript.png") })
// DPAPI persists the credential without exposing it in snapshots or plaintext files.
await page.getByRole("button", { name: "Settings", exact: true }).click()
await page.locator("#key").fill("synthetic-test-key-do-not-use")
await page.getByRole("button", { name: "Save settings", exact: true }).click()
await expect(page.locator("#toast")).toHaveText("Settings saved")
const settingsSource = await readFile(path.join(root, "data", "settings.json"), "utf8")
if (settingsSource.includes("synthetic-test-key-do-not-use")) throw new Error("plaintext credential")
// Close during capture: inject only the native dialog answer, exercise real flush/shutdown.
await page.getByRole("button", { name: "New recording", exact: true }).click()
await expect(page.locator(".status.recording")).toBeVisible()
await expect.poll(async () => { const reply = await page.evaluate(() => window.api.snapshot()); return reply.ok ? reply.value.recordings[0]?.duration : 0 }).toBeGreaterThanOrEqual(1)
// A second launch focuses the current owner rather than starting another recorder.
const binary = executablePath || createRequire(import.meta.url)("electron") as string
const second = spawn(binary, executablePath ? [] : ["."], { env: { ...process.env, BITSBYTES_TEST_DATA: path.join(root, "data") }, stdio: "ignore" })
await new Promise<void>((resolve, reject) => { second.on("exit", code => code === 0 ? resolve() : reject(new Error("second instance failed"))); second.on("error", reject) })
if (await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length) !== 1) throw new Error("duplicate window")
const closed = electron.waitForEvent("close")
await electron.evaluate(({ BrowserWindow, dialog }) => {
  dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  BrowserWindow.getAllWindows()[0].close()
})
await closed
;({ electron, page } = await launch())
await expect(page.locator(".status.saved")).toBeVisible()
await expect(page.locator(".recording-item")).toHaveCount(3)
await page.setViewportSize({ width: 780, height: 560 })
await page.screenshot({ path: path.join(captures, "06-small-window.png") })
await electron.close()
const folders = await readdir(path.join(root, "data", "recordings"))
for (const folder of folders) {
  const saved = JSON.parse(await readFile(path.join(root, "data", "recordings", folder, "recording.json"), "utf8"))
  if (saved.status === "recording") throw new Error("orphaned recording state")
}
if (!(await readdir(path.join(root, "data", "recordings", id))).includes("recording.wav")) throw new Error("finished WAV missing")
console.log(JSON.stringify({ passed: true, recordings: folders.length, data: root, screenshots: captures }))
