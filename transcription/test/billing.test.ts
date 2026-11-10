import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import test from "node:test"
import { Library } from "../src/main/storage.js"
import { Pricing } from "../src/main/pricing.js"

test("reported part costs are committed with transcripts and reconstructed without double-counting", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bb-costs-")); t.after(() => rm(root, { recursive: true, force: true }))
  const library = new Library(root); await library.initialize()
  const row = await library.create({ model: "elevenlabs/scribe-v2", language: "", microphone: "", speakers: false })
  await library.savePart(row.id, 0, "First", undefined, .0012)
  await library.savePart(row.id, 1, "Second", undefined, .0023)
  assert.ok(Math.abs(row.costUSD! - .0035) < 1e-12); assert.equal(row.costComplete, true)
  await assert.rejects(library.savePart(row.id, 1, "Duplicate", undefined, .0023))
  const recovered = new Library(root); await recovered.initialize()
  assert.ok(Math.abs(recovered.get(row.id).costUSD! - .0035) < 1e-12); assert.equal(recovered.get(row.id).costComplete, true)
})
test("missing historical costs remain unknown while reported zero is retained", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bb-cost-missing-")); t.after(() => rm(root, { recursive: true, force: true }))
  const library = new Library(root); await library.initialize()
  const row = await library.create({ model: "elevenlabs/scribe-v2", language: "", microphone: "", speakers: false })
  await library.savePart(row.id, 0, "Older part")
  assert.equal(row.costUSD, undefined); assert.equal(row.costComplete, false)
  await library.savePart(row.id, 1, "Reported free", undefined, 0)
  const recovered = new Library(root); await recovered.initialize()
  assert.equal(recovered.get(row.id).costUSD, 0); assert.equal(recovered.get(row.id).costComplete, false)
})
test("catalog rates use known per-second models and remain available from the local cache", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bb-pricing-")); t.after(() => rm(root, { recursive: true, force: true }))
  let calls = 0
  const pricing = new Pricing(root, async () => {
    calls++
    return Response.json({ data: [
      { id: "elevenlabs/scribe-v2", pricing: { prompt: "0.0000611111111111" } },
      { id: "elevenlabs/scribe-v2-medical", pricing: { prompt: "0.0000611111111111" } },
      { id: "openai/gpt-4o-transcribe", pricing: { prompt: ".0000025", completion: ".00001" } },
      { id: "microsoft/mai-transcribe-2", pricing: { prompt: ".1" } }
    ] })
  })
  await pricing.refresh()
  assert.equal(calls, 1); assert.equal(Object.keys(pricing.rates).length, 2)
  assert.ok(Math.abs(pricing.rates["elevenlabs/scribe-v2"].perSecond * 3600 - .22) < .0001)
  const cached = new Pricing(root, async () => { throw new Error("offline") })
  await cached.initialize(); await cached.refresh()
  assert.equal(cached.rates["elevenlabs/scribe-v2"].perSecond, pricing.rates["elevenlabs/scribe-v2"].perSecond)
})
