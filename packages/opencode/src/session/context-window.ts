import type { Provider } from "@/provider/provider"
import { recommendedContextWindow, validContextWindow, validRecommendedContextWindow } from "@opencode-ai/core/util/context-window"

export function applyContextWindow(
  model: Provider.Model,
  contextWindow?: number,
  buffer?: number,
  savedRecommended?: number,
): Provider.Model & { contextWindow?: number } {
  if (!validContextWindow(contextWindow, model.limit, buffer) || !validRecommendedContextWindow(savedRecommended, model.limit, buffer))
    throw new Error(
      `The saved context window (${contextWindow ?? savedRecommended} tokens) is unavailable. Choose Recommended or a supported size and resend.`,
    )
  const effective = contextWindow ?? savedRecommended ?? recommendedContextWindow(model, buffer)
  if (effective === undefined) return model
  if (contextWindow === undefined && effective === model.limit.context) return model
  return {
    ...model,
    contextWindow: effective,
    limit: {
      ...model.limit,
      context: effective,
      input: model.limit.input ? Math.min(model.limit.input, effective) : undefined,
    },
  }
}
