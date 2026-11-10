import path from "node:path"
import type { Rate } from "../shared.js"
import { supportsSpeakers } from "../speakers.js"
import { atomicWrite, readJSON } from "./storage.js"

export class Pricing {
  rates: Record<string, Rate> = {}
  constructor(private root: string, private request: typeof fetch = fetch) {}
  async initialize() {
    const stored = await readJSON<Record<string, Rate>>(path.join(this.root, "pricing.json"))
    if (stored) for (const [model, rate] of Object.entries(stored)) {
      if (supportsSpeakers(model) && rate && Number.isFinite(rate.perSecond) && rate.perSecond >= 0 && typeof rate.updated === "string" && Date.now() - Date.parse(rate.updated) < 86400000) this.rates[model] = rate
    }
  }
  async refresh() {
    if (["elevenlabs/scribe-v2", "elevenlabs/scribe-v2-medical"].every(model => this.rates[model])) return
    const response = await this.request("https://openrouter.ai/api/v1/models?output_modalities=transcription", { signal: AbortSignal.timeout(10000) })
    if (!response.ok) return
    const body: unknown = await response.json()
    if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data)) return
    for (const value of body.data) {
      if (!value || typeof value !== "object") continue
      const row = value as Record<string, unknown>
      // Scribe's prompt price is explicitly per audio second. Other STT models
      // can bill per token/hour, so their estimates must not reuse this unit.
      if (typeof row.id !== "string" || !supportsSpeakers(row.id) || !row.pricing || typeof row.pricing !== "object") continue
      const pricing = row.pricing as Record<string, unknown>
      if (typeof pricing.prompt !== "string" && typeof pricing.prompt !== "number") continue
      const perSecond = Number(pricing.prompt)
      if (!Number.isFinite(perSecond) || perSecond < 0 || perSecond > 1) continue
      this.rates[row.id] = { perSecond, updated: new Date().toISOString() }
    }
    await atomicWrite(path.join(this.root, "pricing.json"), JSON.stringify(this.rates))
  }
}
