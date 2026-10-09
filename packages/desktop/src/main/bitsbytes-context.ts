import {
  CONTEXT_BUFFER,
  recommendedContextWindow,
  validContextWindow,
  validRecommendedContextWindow,
  type ContextModel,
} from "@opencode-ai/core/util/context-window"
import type { RunPrompt } from "./bitsbytes-runs"
import type { ServerReadyData } from "../preload/types"
import { engineRequest } from "./bitsbytes-engine"
import { conversationProtocol } from "./bitsbytes-conversations"

export async function readPromptContext(server: ServerReadyData, prompt: RunPrompt, protocol?: "v1" | "v2") {
  const current = protocol ?? prompt.protocol ?? (await conversationProtocol(server, prompt.directory))
  if (current === "v2") {
    const result = await engineRequest<{
      data: (ContextModel & { providerID: string; limit: { context: number; output: number } })[]
    }>(server, "/api/model?location[directory]=" + encodeURIComponent(prompt.directory), {}, prompt.directory)
    return {
      model: result.data.find(
        (item) => item.id === prompt.model?.modelID && item.providerID === prompt.model.providerID,
      ),
      buffer: CONTEXT_BUFFER,
    }
  }
  const [catalog, config] = await Promise.all([
    engineRequest<{
      all: { id: string; models: Record<string, ContextModel & { limit: { context: number; output: number } }> }[]
    }>(server, "/provider", {}, prompt.directory),
    engineRequest<{ compaction?: { reserved?: number } }>(server, "/config", {}, prompt.directory),
  ])
  return {
    model: catalog.all.find((provider) => provider.id === prompt.model?.providerID)?.models[prompt.model!.modelID],
    buffer: config.compaction?.reserved ?? CONTEXT_BUFFER,
  }
}

export function validatePromptContext(prompt: RunPrompt, model?: ContextModel, buffer?: number) {
  const limit =
    model?.limit.output === undefined ? undefined : { context: model.limit.context, output: model.limit.output }
  if (
    !validContextWindow(prompt.model?.contextWindow, limit, buffer) ||
    !validRecommendedContextWindow(prompt.recommendedContextWindow, limit, buffer)
  )
    throw new Error("bb.error.contextWindowInvalid")
}

/** Freeze the execution ceiling without turning Recommended into a manual choice. */
export function freezeRecommendedContext(
  prompt: RunPrompt,
  model: ContextModel | undefined,
  buffer?: number,
  previous?: RunPrompt,
): RunPrompt {
  const same =
    previous?.id === prompt.id &&
    previous.sessionID === prompt.sessionID &&
    previous.directory === prompt.directory &&
    (previous.revision ?? 1) === (prompt.revision ?? 1) &&
    previous.model?.providerID === prompt.model?.providerID &&
    previous.model?.modelID === prompt.model?.modelID &&
    previous.model?.contextWindow === prompt.model?.contextWindow
  // An exact retry retains the old snapshot, including legacy snapshots with no ceiling.
  if (same) return { ...prompt, recommendedContextWindow: previous.recommendedContextWindow }
  if (!prompt.model || prompt.model.contextWindow !== undefined) {
    const { recommendedContextWindow: ignored, ...rest } = prompt
    return rest
  }
  const value = model ? recommendedContextWindow(model, buffer) : undefined
  if (
    !validRecommendedContextWindow(
      value,
      model?.limit.output === undefined ? undefined : { context: model.limit.context, output: model.limit.output },
      buffer,
    )
  )
    throw new Error("bb.error.contextWindowInvalid")
  return { ...prompt, recommendedContextWindow: value }
}
