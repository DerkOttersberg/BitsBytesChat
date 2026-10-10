/** Match the engine's canonical provider IDs. A current canonical record wins over stale aliases. */
export function normalizeProviderCredentials(values: Record<string, unknown> = {}) {
  const result: Record<string, unknown> = {}
  for (const [id, value] of Object.entries(values)) {
    const key = id.replace(/\/+$/, "")
    if (id === key || !Object.hasOwn(result, key)) result[key] = value
  }
  return result
}

export function importNativeCredentials<T extends { id: string; integrationID: string }>(current: T[], imported: T[]) {
  const result = [...current]
  for (const row of imported) {
    if (result.some(value => value.id === row.id || value.integrationID === row.integrationID)) continue
    result.push(row)
  }
  return result
}

/** The current native connection wins over imported legacy copies. OAuth tokens are never API keys. */
export function providerApiKey(credentials: {
  openrouter?: string
  providers?: Record<string, unknown>
  nativeCredentials?: { integrationID: string; value: unknown }[]
}, provider: string) {
  const native = credentials.nativeCredentials?.findLast(row => row.integrationID === provider)?.value
  if (native && typeof native === "object" && "type" in native) {
    return native.type === "key" && "key" in native && typeof native.key === "string" ? native.key.trim() || undefined : undefined
  }
  const legacy = credentials.providers?.[provider]
  if (legacy && typeof legacy === "object" && "type" in legacy) {
    return legacy.type === "api" && "key" in legacy && typeof legacy.key === "string" ? legacy.key.trim() || undefined : undefined
  }
  return provider === "openrouter" ? credentials.openrouter?.trim() || undefined : undefined
}
