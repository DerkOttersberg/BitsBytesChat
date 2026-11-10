import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseSpeakers, speakerTranscript, supportsSpeakers } from "../src/speakers.js"
import { atomicWrite, Library } from "../src/main/storage.js"
import { Transcriber } from "../src/main/transcriber.js"

test("speaker words form stable turns, retain punctuation, and distinguish unknown speakers", () => {
  const turns = parseSpeakers({ words: [
    { word: "Hello", start: 0, end: .2, speaker: "speaker_8" },
    { word: ",", start: .2, end: .3, speaker: "speaker_8" },
    { word: "there.", start: .3, end: .8, speaker: "speaker_8" },
    { word: "Hi!", start: 1, end: 1.5, speaker: "speaker_2" },
    { word: "Unknown", start: 1.5, end: 1.8 },
    { word: "Again.", start: 2, end: 2.5, speaker: "speaker_8" }
  ] }, 3)
  assert.deepEqual(turns.map(turn => turn.speaker), [0, 1, -1, 0])
  assert.equal(speakerTranscript(turns), "Speaker 1: Hello, there.\n\nSpeaker 2: Hi!\n\nUnknown speaker: Unknown\n\nSpeaker 1: Again.")
})
test("segment labels are used when word labels are unavailable", () => {
  const turns = parseSpeakers({ words: [{ word: "Hi", start: 0, end: 1 }], segments: [{ text: "Hi", start: 0, end: 1, speaker: 0 }, { text: "Hello", start: 1, end: 2, speaker: 1 }] }, 2)
  assert.equal(turns.length, 2); assert.equal(turns[1].speaker, 1)
})
test("missing speaker labels and invalid timestamps never masquerade as successful diarization", () => {
  assert.throws(() => parseSpeakers({ text: "Plain only" }, 2))
  assert.throws(() => parseSpeakers({ words: [{ word: "Invalid", speaker: 0, start: 5, end: 4 }] }, 6))
  assert.throws(() => parseSpeakers({ words: [{ word: "Invalid", speaker: 0, start: 0, end: 200 }] }, 2))
  assert.equal(supportsSpeakers("elevenlabs/scribe-v2"), true)
  assert.equal(supportsSpeakers("openai/whisper-1"), false)
})
test("whole-recording diarization preserves speaker identity beyond five minutes and survives restart without reupload", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bb-speakers-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const library = new Library(root); await library.initialize()
  const row = await library.create({ model: "elevenlabs/scribe-v2", language: "nl", microphone: "", speakers: true }, "original.wav")
  const samples = Buffer.alloc(301 * 32000); const header = Buffer.alloc(44)
  header.write("RIFF"); header.writeUInt32LE(samples.length + 36, 4); header.write("WAVEfmt ", 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(samples.length, 40)
  await writeFile(path.join(library.directory(row.id), "original.wav"), Buffer.concat([header, samples]))
  let requests = 0
  const request: typeof fetch = async (_url, options) => {
    requests++
    const payload = JSON.parse(String(options?.body))
    assert.equal(payload.response_format, "verbose_json")
    assert.deepEqual(payload.timestamp_granularities, ["word"])
    assert.equal(payload.provider.options.elevenlabs.diarize, true)
    assert.ok(Buffer.from(payload.input_audio.data, "base64").length > 1_000_000)
    return Response.json({ text: "First. Second. Again.", words: [
      { word: "First.", start: 0, end: .2, speaker: 0 },
      { word: "Second.", start: 100, end: 101, speaker: 1 },
      { word: "Again.", start: 300, end: 300.5, speaker: 0 }
    ] })
  }
  await new Transcriber(library, () => {}, request).transcribe(row.id, "synthetic")
  assert.equal(requests, 1); assert.equal(row.status, "complete"); assert.equal(row.completedParts, 1)
  assert.deepEqual(row.turns?.map(turn => turn.speaker), [0, 1, 0])
  assert.equal(row.transcript, "Speaker 1: First.\n\nSpeaker 2: Second.\n\nSpeaker 1: Again.")
  const recovered = new Library(root); await recovered.initialize()
  await new Transcriber(recovered, () => {}, request).transcribe(row.id, "synthetic")
  assert.equal(requests, 1); assert.deepEqual(recovered.get(row.id).turns, row.turns)
  assert.equal(await readFile(path.join(library.directory(row.id), "transcript.txt"), "utf8"), row.transcript)
  await writeFile(path.join(library.directory(row.id), "recording.json"), "corrupt")
  await writeFile(path.join(library.directory(row.id), "recording.backup.json"), "corrupt")
  const damaged = new Library(root); await damaged.initialize()
  assert.equal(damaged.get(row.id).preferences.speakers, true)
  assert.deepEqual(damaged.get(row.id).turns, row.turns)
  await new Transcriber(damaged, () => {}, request).transcribe(row.id, "synthetic")
  assert.equal(requests, 1)
})
test("oversized speaker audio is retained and rejected before any upload", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bb-speaker-limit-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const library = new Library(root); await library.initialize()
  const row = await library.create({ model: "elevenlabs/scribe-v2", language: "", microphone: "", speakers: true }, "original.wav")
  const handle = await open(path.join(library.directory(row.id), "audio.mp3"), "w")
  await handle.truncate(24_000_001); await handle.close()
  await atomicWrite(path.join(library.directory(row.id), "prepared.json"), JSON.stringify({ parts: ["audio.mp3"], duration: 6000, mode: "speakers" }))
  let requests = 0
  await new Transcriber(library, () => {}, async () => { requests++; return Response.json({ text: "Unexpected" }) }).transcribe(row.id, "synthetic")
  assert.equal(requests, 0); assert.equal(row.error, "speakerLimit"); assert.equal(row.status, "error")
})
