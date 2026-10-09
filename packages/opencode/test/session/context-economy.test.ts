import { expect, test } from "bun:test"
import { Provider } from "@/provider/provider"
import { applyContextWindow } from "@/session/context-window"
import { isOverflow, usable } from "@/session/overflow"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

const model: Provider.Model = {
  id: ModelV2.ID.make("gpt-6-astra"),
  providerID: ProviderV2.ID.make("openai"),
  name: "GPT-6 Astra",
  api: { id: "gpt-6-astra", npm: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, image: true, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 1_050_000, output: 128_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

test("V1 Recommended affects real compaction accounting without changing catalog/output/provider arguments", () => {
  const cfg: ConfigV1.Info = {}
  const recommended = applyContextWindow(model)
  const expanded = applyContextWindow(model, 1_050_000)
  expect(recommended.limit.context).toBe(250_000)
  expect(recommended.contextWindow).toBe(250_000)
  expect(recommended.limit.output).toBe(128_000)
  expect(recommended.options).toEqual(model.options)
  expect(recommended.options).not.toHaveProperty("max_output_tokens")
  expect(usable({ cfg, model: recommended })).toBe(122_000)
  expect(usable({ cfg, model: expanded })).toBe(922_000)
  const tokens = { input: 122_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  expect(isOverflow({ cfg, model: recommended, tokens })).toBe(true)
  expect(isOverflow({ cfg, model: expanded, tokens })).toBe(false)
  expect(model.limit.context).toBe(1_050_000)
})

test("V1 retained historical explicit limits remain authoritative; free models keep the reported maximum", () => {
  expect(applyContextWindow(model, 512_000).limit.context).toBe(512_000)
  expect(
    applyContextWindow({
      ...model,
      providerID: ProviderV2.ID.make("openrouter"),
      id: ModelV2.ID.make("community/model:free"),
    }),
  ).toMatchObject({ limit: model.limit })
  expect(() => applyContextWindow(model, 249_000)).toThrow("Choose Recommended")
  expect(applyContextWindow({ ...model, limit: { context: 128_000, output: 8192 } })).not.toHaveProperty(
    "contextWindow",
  )
  expect(applyContextWindow(model, undefined, undefined, 180_000).limit.context).toBe(180_000)
  expect(() =>
    applyContextWindow({ ...model, limit: { context: 160_000, output: 128_000 } }, undefined, undefined, 180_000),
  ).toThrow("Choose Recommended")
  const small = { ...model, limit: { context: 32_000, output: 16_000 } }
  expect(applyContextWindow(small, undefined, undefined, 32_000)).toBe(small)
  expect(usable({ cfg: {}, model: applyContextWindow(small, undefined, undefined, 32_000) })).toBe(16_000)
  expect(() => applyContextWindow(small, 32_000)).toThrow("Choose Recommended")
})
