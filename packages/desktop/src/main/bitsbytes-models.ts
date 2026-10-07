import type { Model } from "../bitsbytes/types"

// Public inference accepts these levels. Catalog-only agent modes such as
// "ultra" must not be sent as Responses reasoning.effort.
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

type CatalogRow = {
  slug?: string; display_name?: string; visibility?: string; context_window?: number
  supported_reasoning_levels?: { effort: string }[]; default_reasoning_level?: string
  id?: string; name?: string; context_length?: number; supported_parameters?: string[]
  reasoning?: { supported_efforts?: string[] | null; default_effort?: string; mandatory?: boolean }
}

export function catalogModels(provider: "chatgpt" | "openrouter", result: { models?: CatalogRow[]; data?: CatalogRow[] }): Model[] {
  const rows = provider === "chatgpt" ? result.models ?? [] : result.data ?? []
  return rows.flatMap((row) => {
    if (provider === "chatgpt" && row.visibility !== "list") return []
    if (provider === "openrouter" && !row.supported_parameters?.includes("tools")) return []
    const id = provider === "chatgpt" ? row.slug : row.id
    const name = provider === "chatgpt" ? row.display_name : row.name
    if (!id || !name) return []
    const supported = provider === "chatgpt"
      ? row.supported_reasoning_levels?.map((level) => level.effort) ?? []
      : row.reasoning?.supported_efforts === null ? EFFORTS : row.reasoning?.supported_efforts ?? []
    const efforts = EFFORTS.filter((effort) => supported.includes(effort) && !(provider === "openrouter" && row.reasoning?.mandatory && effort === "none"))
    const defaultEffort = provider === "chatgpt" ? row.default_reasoning_level : row.reasoning?.default_effort
    return [{ id, name, context: (provider === "chatgpt" ? row.context_window : row.context_length) ?? 128000,
      efforts, ...(defaultEffort && efforts.includes(defaultEffort) ? { defaultEffort } : {}) }]
  })
}

export function modelConfiguration(model: Model, provider: "chatgpt" | "openrouter") {
  const efforts = model.efforts ?? []
  return {
    name: model.name, tool_call: true, attachment: true,
    temperature: provider !== "chatgpt" && efforts.length === 0, reasoning: efforts.length > 0,
    limit: { context: model.context, output: 16384 }, modalities: { input: ["text", "image"], output: ["text"] },
    ...(model.defaultEffort ? { options: { reasoningEffort: model.defaultEffort } } : {}),
    // Override the retained engine's inferred tiers, which can differ from
    // account-specific capabilities returned by these providers.
    variants: Object.fromEntries([...EFFORTS, "thinking"].map((effort) => [effort,
      efforts.includes(effort) ? { reasoningEffort: effort } : { disabled: true },
    ])),
  }
}
