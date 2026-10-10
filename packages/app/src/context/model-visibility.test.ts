import { expect, test } from "bun:test"
import { modelVisible, providerModelVisibility, type ModelPreference } from "./model-visibility"

const router = { providerID: "openrouter", modelID: "fixture/new" }

test("new OpenRouter catalogues stay hidden regardless of release date; other recommendations are unchanged", () => {
  expect(modelVisible(router, undefined, {}, true)).toBe(false)
  expect(modelVisible(router, undefined, {}, false)).toBe(false)
  expect(modelVisible({ ...router, providerID: "openai" }, undefined, {}, true)).toBe(true)
  expect(modelVisible({ ...router, providerID: "openai" }, undefined, {}, false)).toBe(false)
})

test("saved individual choices take precedence over provider defaults", () => {
  expect(modelVisible(router, "show", {}, false)).toBe(true)
  expect(modelVisible(router, "hide", { openrouter: true }, true)).toBe(false)
  expect(modelVisible(router, "show", { openrouter: false }, false)).toBe(true)
})

test("bulk changes include unseen models and retain favorites and other providers", () => {
  const user: ModelPreference[] = [
    { ...router, visibility: "hide", favorite: true },
    { ...router, modelID: "fixture/retired", visibility: "show" },
    { providerID: "openai", modelID: "fixture", visibility: "show" },
  ]
  const enabled = providerModelVisibility(user, { openai: false }, "openrouter", true)
  expect(enabled.providerVisibility).toEqual({ openai: false, openrouter: true })
  expect(enabled.user[0]).toEqual({ ...router, visibility: "show", favorite: true })
  expect(enabled.user[1].visibility).toBe("show")
  expect(enabled.user[2]).toEqual(user[2])
  expect(user[0].visibility).toBe("hide")
  expect(modelVisible({ ...router, modelID: "new-after-refresh" }, undefined, enabled.providerVisibility, false)).toBe(true)
  const disabled = JSON.parse(JSON.stringify(providerModelVisibility(enabled.user, enabled.providerVisibility, "openrouter", false)))
  expect(modelVisible(router, disabled.user[0].visibility, disabled.providerVisibility, true)).toBe(false)
  expect(modelVisible({ ...router, modelID: "new-after-restart" }, undefined, disabled.providerVisibility, true)).toBe(false)
  expect(disabled.user[2]).toEqual(user[2])
})
