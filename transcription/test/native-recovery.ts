import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { createRequire } from "node:module"
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import type { Reply, Snapshot } from "../src/shared.js"

const root = await mkdtemp(path.join(os.tmpdir(), "bb-native-recovery-"))
const data = path.join(root, "data"); await mkdir(data)
await mkdir("test-results", { recursive: true })
const fake = path.join(root, "microphone.wav")
const pcm = Buffer.alloc(32000 * 10); const header = Buffer.alloc(44)
header.write("RIFF"); header.writeUInt32LE(pcm.length + 36, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40)
await writeFile(fake, Buffer.concat([header, pcm]))
// The observer requires Electron's development preload. Packaged executables do
// not accept -r; desktop.ts separately exercises the installed binary lifecycle.
const binary = createRequire(import.meta.url)("electron") as string
const child = spawn(binary, ["-r", path.resolve("test/native-probe.cjs"), ".", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${fake}`], { env: { ...process.env, BITSBYTES_TEST_DATA: data, BITSBYTES_NATIVE_SCREENSHOT: path.resolve("test-results/07-renderer-recovered.png") }, stdio: "ignore" })
type Report = { loads: number; mainPid: number; rendererPid: number; state: Reply<Snapshot> }
async function report(minimum: number): Promise<Report> {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    try {
      const failure = await readFile(path.join(data, "native-probe-error.json"), "utf8").catch(() => undefined)
      if (failure) throw new Error(failure)
      const result = JSON.parse(await readFile(path.join(data, "native-probe.json"), "utf8")) as Report
      if (result.loads >= minimum) return result
    } catch (error) { if (error instanceof Error && !error.message.includes("ENOENT") && !(error instanceof SyntaxError)) throw error }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Native renderer did not recover: ${data}`)
}
let mainPid: number | undefined
try {
  const before = await report(1); mainPid = before.mainPid
  await new Promise(resolve => setTimeout(resolve, 2500))
  await promisify(execFile)("taskkill", ["/PID", String(before.rendererPid), "/F"])
  const after = await report(2)
  assert.equal(after.mainPid, before.mainPid)
  assert.notEqual(after.rendererPid, before.rendererPid)
  assert.ok(after.state.ok)
  if (!after.state.ok) throw new Error("snapshot failed")
  assert.equal(after.state.value.recordings[0].status, "interrupted")
  assert.ok(after.state.value.recordings[0].duration >= 1)
  assert.equal(after.state.value.activeId, undefined)
  const folders = await readdir(path.join(data, "recordings"))
  assert.equal(folders.length, 1)
  assert.ok((await readdir(path.join(data, "recordings", folders[0]))).includes("recording.wav"))
  console.log(JSON.stringify({ passed: true, nativeRendererRecovery: true, root }))
} finally {
  if (mainPid) await promisify(execFile)("taskkill", ["/PID", String(mainPid), "/T", "/F"]).catch(() => undefined)
  else child.kill()
}
