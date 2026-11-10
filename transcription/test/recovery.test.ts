import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { Library, atomicWrite } from "../src/main/storage.js"
import { Transcriber } from "../src/main/transcriber.js"

const preferences = { model: "elevenlabs/scribe-v2", language: "nl", microphone: "", speakers: false }
async function setup(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bb-transcription-test-"))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const library = new Library(root); await library.initialize()
  return library
}
test("unacknowledged audio is idempotent; gaps and altered retries are rejected", async t => {
  const library = await setup(t); const row = await library.create(preferences)
  const audio = Buffer.alloc(32000, 4)
  assert.equal(await library.append(row.id, 0, audio), 1)
  assert.equal(await library.append(row.id, 0, audio), 1)
  await assert.rejects(library.append(row.id, 0, Buffer.alloc(32000, 3)))
  await assert.rejects(library.append(row.id, 2, audio))
  assert.equal((await readdir(library.directory(row.id))).filter(file => file.endsWith(".pcm")).length, 1)
})
test("restart recovers audio absent from stale manifest and the final partial second", async t => {
  const library = await setup(t); const row = await library.create(preferences)
  await library.append(row.id, 0, Buffer.alloc(32000, 7)); await library.append(row.id, 1, Buffer.alloc(9000, 8))
  const recovered = new Library(library.root); await recovered.initialize()
  const saved = recovered.get(row.id)
  assert.equal(saved.duration, 1.28125); assert.equal(saved.status, "interrupted")
  const wav = await readFile(await recovered.assemble(row.id))
  assert.equal(wav.readUInt32LE(40), 41000); assert.equal(wav.length, 41044)
  assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav[44], 7); assert.equal(wav.at(-1), 8)
})
test("missing and corrupted manifests do not hide audio or committed transcript parts", async t => {
  const library = await setup(t); const row = await library.create(preferences)
  await library.append(row.id, 0, Buffer.alloc(32000)); await library.savePart(row.id, 0, "First saved part")
  await writeFile(path.join(library.directory(row.id), "recording.json"), "corrupt")
  await writeFile(path.join(library.directory(row.id), "recording.backup.json"), "corrupt")
  const recovered = new Library(library.root); await recovered.initialize()
  assert.equal(recovered.get(row.id).transcript, "First saved part")
  assert.equal(recovered.get(row.id).duration, 1)
  assert.equal(recovered.get(row.id).completedParts, 1)
})
test("imports are copied locally and recovered if the manifest write was interrupted", async t => {
  const library = await setup(t); const source = path.join(library.root, "source.wav")
  await writeFile(source, Buffer.from("original audio"))
  const row = await library.create(preferences, "importing"); await library.copyImport(row.id, source)
  await rm(source)
  await writeFile(path.join(library.directory(row.id), "recording.json"), "corrupt")
  await writeFile(path.join(library.directory(row.id), "recording.backup.json"), "corrupt")
  const recovered = new Library(library.root); await recovered.initialize()
  assert.equal((await readFile(await recovered.assemble(row.id))).toString(), "original audio")
})
test("an interrupted transcript commit is recovered from its part file", async t => {
  const library = await setup(t); const row = await library.create(preferences)
  await atomicWrite(path.join(library.directory(row.id), "part-000000.json"), JSON.stringify({ text: "Paid work survives" }))
  const recovered = new Library(library.root); await recovered.initialize()
  assert.equal(recovered.get(row.id).transcript, "Paid work survives")
})
test("real FFmpeg preparation saves MP3; valid responses commit before completion", async t => {
  const library = await setup(t); const row = await library.create(preferences)
  const pcm = Buffer.alloc(32000)
  for (let i = 0; i < 16000; i++) pcm.writeInt16LE(Math.sin(i * 2 * Math.PI * 440 / 16000) * 5000, i * 2)
  await library.append(row.id, 0, pcm); row.status = "saved"
  let requests = 0
  const request: typeof fetch = async (url, options) => {
    requests++; assert.equal(String(url), "https://openrouter.ai/api/v1/audio/transcriptions")
    const body = JSON.parse(String(options?.body))
    assert.equal(body.language, "nl"); assert.equal(body.input_audio.format, "mp3")
    assert.ok(Buffer.from(body.input_audio.data, "base64").length > 1000)
    return Response.json({ text: "This is the saved transcript." })
  }
  const transcriber = new Transcriber(library, () => {}, request)
  await transcriber.transcribe(row.id, "test-only")
  assert.equal(row.status, "complete"); assert.equal(requests, 1)
  assert.equal(await readFile(path.join(library.directory(row.id), "transcript.txt"), "utf8"), "This is the saved transcript.")
  assert.ok((await readFile(path.join(library.directory(row.id), "audio.mp3"))).length > 1000)
  await transcriber.transcribe(row.id, "test-only"); assert.equal(requests, 1)
})
test("resume retries only unfinished parts after provider failure and restart", async t => {
  const library = await setup(t); const row = await library.create(preferences); row.status = "saved"
  for (const file of ["upload-000000.mp3", "upload-000001.mp3", "audio.mp3"]) await writeFile(path.join(library.directory(row.id), file), "test audio")
  await atomicWrite(path.join(library.directory(row.id), "prepared.json"), JSON.stringify({ parts: ["upload-000000.mp3", "upload-000001.mp3"], duration: 600 }))
  let requests = 0
  const request: typeof fetch = async () => { requests++; return requests === 1 ? Response.json({ text: "Completed first part" }) : new Response(null, { status: 429 }) }
  await new Transcriber(library, () => {}, request).transcribe(row.id, "test-only")
  assert.equal(row.status, "error"); assert.equal(row.completedParts, 1); assert.equal(row.error, "quota")
  const recovered = new Library(library.root); await recovered.initialize()
  let resumed = 0
  await new Transcriber(recovered, () => {}, async () => { resumed++; return Response.json({ text: "Second part" }) }).transcribe(row.id, "test-only")
  assert.equal(resumed, 1); assert.equal(recovered.get(row.id).transcript, "Completed first part\n\nSecond part")
})
test("real FFmpeg splits long imports into bounded parts and preserves the source", async t => {
  const library = await setup(t); const row = await library.create(preferences, "original.wav")
  const samples = Buffer.alloc(301 * 32000); const header = Buffer.alloc(44)
  header.write("RIFF"); header.writeUInt32LE(samples.length + 36, 4); header.write("WAVEfmt ", 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write("data", 36); header.writeUInt32LE(samples.length, 40)
  const source = path.join(library.directory(row.id), "original.wav")
  await writeFile(source, Buffer.concat([header, samples]))
  const prepared = await new Transcriber(library, () => {}).prepare(row.id, new AbortController().signal)
  assert.equal(prepared.parts.length, 2); assert.ok(Math.abs(prepared.duration - 301) < 0.1)
  assert.equal((await readFile(source)).length, samples.length + 44)
  for (const file of prepared.parts) assert.ok((await readFile(path.join(library.directory(row.id), file))).length < 2_000_000)
})
test("aborted requests retain original audio and never automatically retry", async t => {
  const library = await setup(t); const row = await library.create(preferences); row.status = "saved"
  await writeFile(path.join(library.directory(row.id), "upload-000000.mp3"), "audio")
  await atomicWrite(path.join(library.directory(row.id), "prepared.json"), JSON.stringify({ parts: ["upload-000000.mp3"], duration: 1 }))
  let requests = 0
  const request: typeof fetch = async (_url, options) => {
    requests++
    return new Promise((_resolve, reject) => { options?.signal?.addEventListener("abort", () => reject(new Error("aborted"))); setTimeout(() => transcriber.cancel(), 20) })
  }
  const transcriber = new Transcriber(library, () => {}, request)
  await transcriber.transcribe(row.id, "test-only")
  assert.equal(requests, 1); assert.equal(row.error, "uncertain"); assert.equal(row.completedParts, 0)
  assert.equal(await readFile(path.join(library.directory(row.id), "upload-000000.mp3"), "utf8"), "audio")
})
test("delete removes a recording from the library atomically and rejects path traversal", async t => {
  const library = await setup(t); const row = await library.create(preferences)
  assert.throws(() => library.directory("../../anything"))
  await library.remove(row.id)
  const recovered = new Library(library.root); await recovered.initialize()
  assert.equal(recovered.records.size, 0)
})
