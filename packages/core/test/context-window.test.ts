import { expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import {
  contextWindowOptions,
  recommendedContextWindow,
  validContextWindow,
  validRecommendedContextWindow,
} from "@opencode-ai/core/util/context-window"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { AbsolutePath } from "@opencode-ai/core/schema"

test("context choices respect reported capacity, output reserve and additional input room", () => {
  expect(contextWindowOptions({ context: 200_000, output: 32_000 })).toEqual([64_000, 128_000, 200_000])
  expect(contextWindowOptions({ context: 200_000, output: 32_000 }, 80_000)).toEqual([128_000, 200_000])
  expect(contextWindowOptions({ context: 0, output: 0 })).toEqual([])
  expect(contextWindowOptions(undefined)).toEqual([])
  expect(validContextWindow(undefined, undefined)).toBe(true)
  for (const value of [0, -1, NaN, Infinity, 64_000.1, 32_000, 256_000])
    expect(validContextWindow(value, { context: 200_000, output: 32_000 })).toBe(false)
})

test("Recommended caps paid and subscription contexts while keeping proven free routes at capacity", () => {
  const model = {
    id: "gpt-6-astra",
    providerID: "openai",
    limit: { context: 1_050_000, output: 128_000 },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  }
  expect(recommendedContextWindow(model)).toBe(250_000)
  expect(recommendedContextWindow({ ...model, providerID: "chatgpt" })).toBe(250_000)
  expect(recommendedContextWindow({ ...model, providerID: "github-copilot" })).toBe(250_000)
  expect(recommendedContextWindow({ ...model, providerID: "opencode", id: "free-model" })).toBe(1_050_000)
  expect(
    recommendedContextWindow({
      ...model,
      providerID: "opencode",
      cost: { ...model.cost, experimentalOver200K: { input: 1, output: 2 } },
    }),
  ).toBe(200_000)
  expect(recommendedContextWindow({ ...model, providerID: "openrouter", id: "community/model:free" })).toBe(1_050_000)
  expect(recommendedContextWindow({ ...model, providerID: "ollama" })).toBe(1_050_000)
  expect(recommendedContextWindow({ ...model, limit: { context: 128_000, output: 8192 } })).toBe(128_000)
  expect(recommendedContextWindow({ ...model, limit: { context: 0, output: 0 } })).toBeUndefined()
  expect(contextWindowOptions(model.limit)).toContain(250_000)
})

test("Recommended respects increased-price metadata from both catalogs and keeps safe output room", () => {
  const base = { input: 2, output: 10, cache: { read: 1, write: 1 } }
  const tier = { ...base, input: 4, tier: { type: "context", size: 200_000 } }
  const model = { id: "paid", providerID: "api", limit: { context: 1_000_000, output: 32_000 } }
  expect(recommendedContextWindow({ ...model, cost: { ...base, tiers: [tier] } })).toBe(200_000)
  expect(recommendedContextWindow({ ...model, cost: [base, tier] })).toBe(200_000)
  expect(recommendedContextWindow({ ...model, cost: { ...base, experimentalOver200K: { ...base, output: 20 } } })).toBe(
    200_000,
  )
  expect(recommendedContextWindow({ ...model, cost: [base, { ...tier, input: 1 }] })).toBe(250_000)
  expect(
    recommendedContextWindow({ ...model, cost: [base, { ...tier, tier: { type: "context", size: 272_000 } }] }),
  ).toBe(250_000)
  expect(recommendedContextWindow({ ...model, limit: { context: 1_000_000, output: 300_000 } })).toBe(316_000)
  expect(recommendedContextWindow(model, 270_000)).toBe(286_000)
  expect(validRecommendedContextWindow(180_000, model.limit)).toBe(true)
  expect(validRecommendedContextWindow(180_000, model.limit, 170_000)).toBe(false)
})

test("small models keep catalog Recommended parity while manual reductions retain safe reserves", () => {
  const limit = { context: 32_000, output: 16_000 }
  for (const providerID of ["openai", "ollama"])
    expect(validRecommendedContextWindow(recommendedContextWindow({ id: "small", providerID, limit }), limit)).toBe(
      true,
    )
  expect(contextWindowOptions(limit)).toEqual([])
  expect(validContextWindow(32_000, limit)).toBe(false)
  expect(validRecommendedContextWindow(31_000, limit)).toBe(false)
  expect(validRecommendedContextWindow(33_000, limit)).toBe(false)
  expect(validRecommendedContextWindow(0, { context: 0, output: 0 })).toBe(false)
})

test("selected budget affects the resolved execution route and preserves output/variant settings", async () => {
  const catalog = ModelV2.Info.make({
    id: ModelV2.ID.make("model"),
    providerID: ProviderV2.ID.make("provider"),
    name: "Model",
    api: { id: ModelV2.ID.make("api-model"), type: "aisdk", package: "@ai-sdk/openai" },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: { headers: {}, body: { store: false } },
    variants: [{ id: ModelV2.VariantID.make("medium"), headers: {}, body: { reasoning: { effort: "medium" } } }],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 200_000, output: 32_000 },
  })
  const session = (contextWindow?: number) =>
    SessionV2.Info.make({
      id: SessionV2.ID.make("ses_context"),
      projectID: ProjectV2.ID.global,
      title: "Context test",
      model: {
        id: catalog.id,
        providerID: catalog.providerID,
        variant: ModelV2.VariantID.make("medium"),
        contextWindow,
      },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
      location: { directory: AbsolutePath.make(process.cwd()) },
    })
  const recommended = await Effect.runPromise(SessionRunnerModel.resolve(session(), catalog))
  const selected = await Effect.runPromise(SessionRunnerModel.resolve(session(64_000), catalog))
  expect(recommended.route.defaults.limits).toEqual({ context: 200_000, output: 32_000 })
  expect(selected.route.defaults.limits).toEqual({ context: 64_000, output: 32_000 })
  expect(selected.route.defaults.http?.body).toEqual(recommended.route.defaults.http?.body)
  expect(selected.route.defaults.http?.body).not.toHaveProperty("max_output_tokens")
  expect(catalog.limit.context).toBe(200_000)
  const invalid = await Effect.runPromise(SessionRunnerModel.resolve(session(256_000), catalog).pipe(Effect.flip))
  expect(invalid._tag).toBe("SessionRunnerModel.ContextWindowUnavailableError")
  expect(invalid.message).toContain("Choose Recommended")
  const large = { ...catalog, limit: { context: 1_050_000, output: 128_000 } }
  const economic = await Effect.runPromise(SessionRunnerModel.resolve(session(), large))
  const expanded = await Effect.runPromise(SessionRunnerModel.resolve(session(1_050_000), large))
  expect(economic.route.defaults.limits).toEqual({ context: 250_000, output: 128_000 })
  expect(expanded.route.defaults.limits).toEqual({ context: 1_050_000, output: 128_000 })
  expect(expanded.route.defaults.http?.body).toEqual(economic.route.defaults.http?.body)
  expect(large.limit.context).toBe(1_050_000)
  const frozen = { ...session(), model: { ...session().model!, recommendedContextWindow: 180_000 } }
  const retained = await Effect.runPromise(SessionRunnerModel.resolve(frozen, large))
  expect(retained.route.defaults.limits).toEqual({ context: 180_000, output: 128_000 })
  expect(frozen.model.contextWindow).toBeUndefined()
  const unsupported = await Effect.runPromise(
    SessionRunnerModel.resolve(frozen, { ...large, limit: { context: 160_000, output: 128_000 } }).pipe(Effect.flip),
  )
  expect(unsupported._tag).toBe("SessionRunnerModel.ContextWindowUnavailableError")
})
