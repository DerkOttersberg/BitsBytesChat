import { expect, test } from "bun:test"
import { freezeRecommendedContext, readPromptContext, validatePromptContext } from "./bitsbytes-context"
import { createServer } from "node:http"
import type { RunPrompt } from "./bitsbytes-runs"

const prompt: RunPrompt = {
  id: "msg_budget",
  sessionID: "ses_budget",
  directory: "D:/owned-qa",
  text: "Keep this request",
  model: { providerID: "openai", modelID: "gpt-6-astra" },
  revision: 1,
}
const model = {
  id: "gpt-6-astra",
  providerID: "openai",
  limit: { context: 1_050_000, output: 128_000 },
  cost: { input: 2, output: 10, tiers: [{ input: 4, output: 15, tier: { type: "context", size: 200_000 } }] },
}

test("first admission freezes Recommended separately from the visible model selection", () => {
  const result = freezeRecommendedContext(prompt, model)
  expect(result.recommendedContextWindow).toBe(200_000)
  expect(result.model?.contextWindow).toBeUndefined()
  expect(prompt).not.toHaveProperty("recommendedContextWindow")
})

test("exact retries keep their frozen ceiling after price/capacity/catalog changes", () => {
  const saved = freezeRecommendedContext(prompt, model)
  const revisedCatalog = { ...model, cost: { input: 2, output: 10, tiers: [] } }
  const retry = freezeRecommendedContext(
    { ...prompt, recommendedContextWindow: 1_050_000 },
    revisedCatalog,
    undefined,
    saved,
  )
  expect(retry.recommendedContextWindow).toBe(200_000)
  expect(retry.model?.contextWindow).toBeUndefined()
  expect(
    freezeRecommendedContext({ ...prompt, id: "msg_new" }, revisedCatalog, undefined, saved).recommendedContextWindow,
  ).toBe(250_000)
  expect(
    freezeRecommendedContext({ ...prompt, revision: 2 }, revisedCatalog, undefined, saved).recommendedContextWindow,
  ).toBe(250_000)
})

test("an explicit override remains authoritative and new callers cannot forge a Recommended expansion", () => {
  const manual = freezeRecommendedContext(
    { ...prompt, model: { ...prompt.model!, contextWindow: 1_050_000 }, recommendedContextWindow: 250_000 },
    model,
  )
  expect(manual.model?.contextWindow).toBe(1_050_000)
  expect(manual).not.toHaveProperty("recommendedContextWindow")
  expect(
    freezeRecommendedContext({ ...prompt, recommendedContextWindow: 1_050_000 }, model).recommendedContextWindow,
  ).toBe(200_000)
})

test("legacy exact retries retain their original request shape rather than inventing a new fingerprint", () => {
  expect(freezeRecommendedContext(prompt, model, undefined, prompt).recommendedContextWindow).toBeUndefined()
})

test("small-model Recommended admits its original capacity without exposing an unsafe manual choice", () => {
  const small = { ...model, limit: { context: 32_000, output: 16_000 } }
  const frozen = freezeRecommendedContext(prompt, small)
  expect(frozen.recommendedContextWindow).toBe(32_000)
  expect(frozen.model?.contextWindow).toBeUndefined()
  expect(() => validatePromptContext(frozen, small)).not.toThrow()
  expect(() => validatePromptContext({ ...prompt, model: { ...prompt.model!, contextWindow: 32_000 } }, small)).toThrow(
    "contextWindowInvalid",
  )
})

test("saved Recommended validates capacity and reserves even when its catalog price threshold is not a menu size", () => {
  expect(() => validatePromptContext({ ...prompt, recommendedContextWindow: 180_000 }, model)).not.toThrow()
  expect(() =>
    validatePromptContext(
      { ...prompt, recommendedContextWindow: 180_000 },
      { ...model, limit: { context: 160_000, output: 128_000 } },
    ),
  ).toThrow("contextWindowInvalid")
  expect(() => validatePromptContext({ ...prompt, recommendedContextWindow: 180_000 }, model, 170_000)).toThrow(
    "contextWindowInvalid",
  )
  expect(() =>
    validatePromptContext({ ...prompt, model: { ...prompt.model!, contextWindow: 1_050_000 } }, model),
  ).not.toThrow()
})

test.each(["v1", "v2"] as const)(
  "%s host context lookup uses the actual protocol and selected location",
  async (protocol) => {
    const seen: string[] = []
    const server = createServer((request, response) => {
      seen.push(request.url ?? "")
      response.setHeader("content-type", "application/json")
      if (request.url?.startsWith("/api/model")) response.end(JSON.stringify({ data: [model] }))
      else if (request.url === "/provider")
        response.end(JSON.stringify({ all: [{ id: model.providerID, models: { [model.id]: model } }] }))
      else if (request.url === "/config") response.end(JSON.stringify({ compaction: { reserved: 80_000 } }))
      else response.writeHead(404).end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing fixture address")
    try {
      const result = await readPromptContext({ url: `http://127.0.0.1:${address.port}` }, prompt, protocol)
      expect(result.model?.id).toBe(model.id)
      expect(result.buffer).toBe(protocol === "v2" ? 20_000 : 80_000)
      expect(seen).toEqual(
        protocol === "v2"
          ? ["/api/model?location[directory]=" + encodeURIComponent(prompt.directory)]
          : ["/provider", "/config"],
      )
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
)
