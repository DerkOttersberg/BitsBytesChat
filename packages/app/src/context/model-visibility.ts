export type ModelKey = { providerID: string; modelID: string }
export type ModelVisibility = "show" | "hide"
export type ModelPreference = ModelKey & { visibility: ModelVisibility; favorite?: boolean }
export type ProviderVisibility = Record<string, boolean>

export function modelVisible(
  model: ModelKey,
  explicit: ModelVisibility | undefined,
  providers: ProviderVisibility | undefined,
  recommended: boolean,
) {
  if (explicit) return explicit === "show"
  const provider = providers?.[model.providerID]
  if (typeof provider === "boolean") return provider
  // Aggregated catalogues must not automatically flood a new user's picker.
  if (model.providerID === "openrouter") return false
  return recommended
}

export function providerModelVisibility(
  user: readonly ModelPreference[],
  providers: ProviderVisibility | undefined,
  providerID: string,
  visible: boolean,
) {
  return {
    providerVisibility: { ...providers, [providerID]: visible },
    user: user.map((item) => item.providerID === providerID ? { ...item, visibility: visible ? "show" as const : "hide" as const } : item),
  }
}
