import type { Provider } from "@/provider/provider"
import { validContextWindow } from "@opencode-ai/core/util/context-window"

export function applyContextWindow(
  model: Provider.Model,
  contextWindow?: number,
  buffer?: number,
): Provider.Model & { contextWindow?: number } {
  if (!validContextWindow(contextWindow, model.limit, buffer))
    throw new Error(
      `The saved context window (${contextWindow} tokens) is unavailable. Choose Recommended or a supported size and resend.`,
    )
  if (contextWindow === undefined) return model
  return {
    ...model,
    contextWindow,
    limit: {
      ...model.limit,
      context: contextWindow,
      input: model.limit.input ? Math.min(model.limit.input, contextWindow) : undefined,
    },
  }
}
