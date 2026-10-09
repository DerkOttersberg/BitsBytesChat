import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Model } from "../src/model"
import { Provider } from "../src/provider"

test("a frozen Recommended model budget serializes independently of the explicit override", () => {
  const value = {
    id: Model.ID.make("model"),
    providerID: Provider.ID.make("provider"),
    contextWindow: undefined,
    recommendedContextWindow: 180_000,
  }
  expect(Schema.encodeSync(Model.Ref)(value)).toEqual({
    id: "model",
    providerID: "provider",
    recommendedContextWindow: 180_000,
  })
  expect(Schema.decodeUnknownSync(Model.Ref)({ id: "model", providerID: "provider" })).not.toHaveProperty(
    "recommendedContextWindow",
  )
  for (const invalid of [0, -1, 180_000.1])
    expect(() => Schema.decodeUnknownSync(Model.Ref)({ ...value, recommendedContextWindow: invalid })).toThrow()
})
