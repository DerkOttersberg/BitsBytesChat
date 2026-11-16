import { _electron, expect } from "@playwright/test"
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const adb = process.env.ADB!
const device = process.env.ANDROID_SERIAL || "emulator-5558"
assert.ok(adb && device.startsWith("emulator-"), "Use an owned test emulator")
const run = promisify(execFile)
async function command(...args: string[]) { return (await run(adb, ["-s", device, ...args])).stdout }
const captures = path.resolve("test-results"); await mkdir(captures, { recursive: true })
const root = await mkdtemp(path.join(captures, "android-link-"))
const electron = await _electron.launch({ ...(process.env.BITSBYTES_TEST_EXECUTABLE ? { executablePath: process.env.BITSBYTES_TEST_EXECUTABLE } : {}), args: [...(process.env.BITSBYTES_TEST_EXECUTABLE ? [] : ["."]), "--background"], env: { ...process.env, BITSBYTES_TEST_DATA: path.join(root, "data") } })
try {
  if (process.platform === "win32") {
    const name = "BitsBytesTranscription-QA-" + randomUUID()
    try {
      const exe = await electron.evaluate(({ app }, name) => {
        app.setLoginItemSettings({ name, path: process.execPath, args: ["--background"], openAtLogin: true })
        return process.execPath
      }, name)
      const registry = await run("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", name])
      assert.ok(registry.stdout.includes(exe) && registry.stdout.includes("--background"), "Windows sign-in Run entry must launch the packaged executable in the background")
    } finally { await electron.evaluate(({ app }, name) => app.setLoginItemSettings({ name, path: process.execPath, args: ["--background"], openAtLogin: false }), name) }
  }
  const page = await electron.firstWindow(); await page.waitForSelector("aside")
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false)
  const paired = await page.evaluate(() => window.api.pairing()); if (!paired.ok) throw new Error(paired.error)
  const config = path.join(root, "pairing.json"); const qr = path.join(root, "qr.png")
  await writeFile(config, JSON.stringify({ pairing: paired.value.code })); await writeFile(qr, Buffer.from(paired.value.qr.split(",")[1], "base64"))
  await command("push", config, "/data/local/tmp/bbt-pair.json"); await command("push", qr, "/data/local/tmp/bbt-qr.png")
  await command("shell", "rm", "-f", "/data/local/tmp/bbt-link-received", "/data/local/tmp/bbt-link-retry")
  const instrumentation = spawn(adb, ["-s", device, "shell", "am", "instrument", "-w", "-e", "class", "nl.bitsbytes.transcription.LinkIntegrationTest", "-e", "pairingFile", "/data/local/tmp/bbt-pair.json", "nl.bitsbytes.transcription.debug.test/androidx.test.runner.AndroidJUnitRunner"], { stdio: ["ignore", "pipe", "pipe"] })
  let output = ""; instrumentation.stdout.on("data", value => { output += String(value) }); instrumentation.stderr.on("data", value => { output += String(value) })
  const ended = new Promise<number | null>(resolve => instrumentation.on("exit", resolve))
  const until = Date.now() + 90000
  while (Date.now() < until) {
    if ((await command("shell", "ls", "/data/local/tmp/bbt-link-received").catch(() => "")).includes("bbt-link-received")) break
    if (instrumentation.exitCode !== null) throw new Error(output)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  const expected = "Spreker 1: lange conversatie — café 中文 🤖\n".repeat(22000)
  const actual = await electron.evaluate(({ clipboard }) => clipboard.readText())
  assert.equal(createHash("sha256").update(actual).digest("hex"), createHash("sha256").update(expected).digest("hex")); assert.equal(actual.length, expected.length)
  await expect(page.locator(".phone-origin")).toBeVisible(); await expect(page.locator(".recording-item")).toHaveCount(1)
  await electron.evaluate(({ clipboard }) => clipboard.writeText("A newer clipboard value"))
  await command("shell", "touch", "/data/local/tmp/bbt-link-retry")
  assert.equal(await ended, 0); assert.match(output, /OK \(1 test\)/)
  assert.equal(await electron.evaluate(({ clipboard }) => clipboard.readText()), "A newer clipboard value")
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false)
  await writeFile(path.join(captures, "phone-desktop.txt"), output + `\nClipboard UTF-8 bytes: ${Buffer.byteLength(actual)}\nSHA256: ${createHash("sha256").update(actual).digest("hex")}\nAcknowledged retry preserved newer clipboard.\n`)
  console.log(JSON.stringify({ passed: true, androidToWindowsClipboard: true, bytes: Buffer.byteLength(actual), acknowledgedRetry: true, background: true, root }))
} finally { await electron.close().catch(() => undefined) }
