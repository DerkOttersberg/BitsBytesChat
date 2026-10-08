import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createPromptState, DEFAULT_PROMPT } from "./prompt-state"

describe("prompt state initialization", () => {
  test("context selections remain per chat/model and independent of effort and draft reset", () => {
    createRoot(dispose => {
      const first = createPromptState({ model: { providerID: "provider", modelID: "model", contextWindow: 64_000, variant: "medium" } })
      const other = createPromptState()
      const key = JSON.stringify(["provider", "model"])
      first.model.context.set(key, 64_000)
      first.model.context.set(JSON.stringify(["provider", "other"]), 128_000)
      first.model.set({ ...first.model.current()!, variant: "high" })
      first.reset()
      expect(first.model.current()?.contextWindow).toBe(64_000)
      expect(first.model.context.get(key)).toBe(64_000)
      expect(other.model.context.get(key)).toBeUndefined()
      first.model.context.set(key, undefined)
      expect(first.model.context.get(key)).toBeUndefined()
      expect(first.model.context.get(JSON.stringify(["provider", "other"]))).toBe(128_000)
      dispose()
    })
  })
  test("initializes prompt text, cursor, and model together", () => {
    createRoot((dispose) => {
      const model = { providerID: "anthropic", modelID: "claude", variant: "high" }
      const prompt = createPromptState({ prompt: "hello", model })

      expect(prompt.current()).toEqual([{ type: "text", content: "hello", start: 0, end: 5 }])
      expect(prompt.cursor()).toBe(5)
      expect(prompt.model.current()).toEqual(model)
      expect(prompt.model.current()).not.toBe(model)
      dispose()
    })
  })

  test("uses the default prompt without initial values", () => {
    createRoot((dispose) => {
      const prompt = createPromptState()

      expect(prompt.current()).toEqual(DEFAULT_PROMPT)
      expect(prompt.cursor()).toBeUndefined()
      expect(prompt.model.current()).toBeUndefined()
      dispose()
    })
  })
})
