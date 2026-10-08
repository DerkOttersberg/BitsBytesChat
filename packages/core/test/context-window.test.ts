import { expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import { contextWindowOptions, validContextWindow } from "@opencode-ai/core/util/context-window"
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
  for (const value of [0, -1, NaN, Infinity, 64_000.1, 32_000, 256_000]) expect(validContextWindow(value, { context: 200_000, output: 32_000 })).toBe(false)
})

test("selected budget affects the resolved execution route and preserves output/variant settings", async () => {
  const catalog = ModelV2.Info.make({
    id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider"), name: "Model",
    api: { id: ModelV2.ID.make("api-model"), type: "aisdk", package: "@ai-sdk/openai" },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: { headers: {}, body: { store: false } },
    variants: [{ id: ModelV2.VariantID.make("medium"), headers: {}, body: { reasoning: { effort: "medium" } } }],
    time: { released: 0 }, cost: [], status: "active", enabled: true, limit: { context: 200_000, output: 32_000 },
  })
  const session = (contextWindow?: number) => SessionV2.Info.make({
    id: SessionV2.ID.make("ses_context"), projectID: ProjectV2.ID.global, title: "Context test",
    model: { id: catalog.id, providerID: catalog.providerID, variant: ModelV2.VariantID.make("medium"), contextWindow },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) }, location: { directory: AbsolutePath.make(process.cwd()) },
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
})
