import { expect, test } from "bun:test"
import { importNativeCredentials, normalizeProviderCredentials, providerApiKey } from "./bitsbytes-credentials"

test("legacy reconnect retains the canonical current OAuth grant and removes trailing-slash aliases", () => {
  const latest = { type: "oauth", refresh: "new-rotating-token", access: "current" }
  const stale = { type: "oauth", refresh: "old-rotating-token", access: "expired" }
  for (const entries of [[['openai', latest], ['openai/', stale]], [['openai//', stale], ['openai', latest]]]) {
    expect(normalizeProviderCredentials(Object.fromEntries(entries))).toEqual({ openai: latest })
  }
  expect(normalizeProviderCredentials({ "openai/": latest })).toEqual({ openai: latest })
})

test("media uses the current provider connection instead of stale legacy keys or OAuth tokens", () => {
  const credentials = { openrouter: "stale", providers: { openrouter: { type: "api", key: "older" } }, nativeCredentials: [{ integrationID: "openrouter", value: { type: "key", key: " current " } }] }
  expect(providerApiKey(credentials, "openrouter")).toBe("current")
  expect(providerApiKey({ ...credentials, nativeCredentials: [] }, "openrouter")).toBe("older")
  expect(providerApiKey({ providers: { openai: { type: "oauth", access: "not-an-image-api-key" } } }, "openai")).toBeUndefined()
  expect(providerApiKey({ providers: { openai: { type: "api", key: "old" } }, nativeCredentials: [{ integrationID: "openai", value: { type: "oauth", access: "current-oauth" } }] }, "openai")).toBeUndefined()
  expect(providerApiKey({ providers: { openai: { type: "api", key: "api-key" } } }, "openai")).toBe("api-key")
})

test("native migration never replaces a reconnect or refresh with a stale database credential", () => {
  const current = [{ id: "current", integrationID: "openai", value: { refresh: "rotated" } }]
  const stale = { id: "old", integrationID: "openai", value: { refresh: "revoked" } }
  const another = { id: "router", integrationID: "openrouter", value: { key: "fixture" } }
  expect(importNativeCredentials(current, [stale, another, another])).toEqual([...current, another])
  expect(importNativeCredentials(importNativeCredentials(current, [stale, another]), [stale, another])).toEqual([...current, another])
  expect(current).toHaveLength(1)
})
