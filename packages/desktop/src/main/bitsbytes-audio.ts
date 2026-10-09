import type { AudioModel, Engine, Settings } from "../bitsbytes/types"
import { stateRecord } from "./bitsbytes-state"

export const AUDIO_DEFAULT_MODEL = "openai/whisper-large-v3-turbo"
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]{0,180}$/i
const LANGUAGE = /^[a-z]{2}$/

export function openrouterAudioKey(credentials: {
  openrouter?: string
  providers?: Record<string, unknown>
  nativeCredentials?: { integrationID: string; value: unknown }[]
}) {
  if (credentials.openrouter?.trim()) return credentials.openrouter.trim()
  const legacy = credentials.providers?.openrouter
  if (stateRecord(legacy) && legacy.type === "api" && typeof legacy.key === "string" && legacy.key.trim())
    return legacy.key.trim()
  const native = credentials.nativeCredentials?.findLast(
    (row) =>
      row.integrationID === "openrouter" &&
      stateRecord(row.value) &&
      row.value.type === "key" &&
      typeof row.value.key === "string" &&
      row.value.key.trim(),
  )?.value
  return stateRecord(native) && typeof native.key === "string" ? native.key.trim() : undefined
}

export function audioPreferences(settings: Pick<Settings, "engine" | "audioModel" | "audioLanguage">) {
  if (!["parakeet", "whisper", "openrouter"].includes(settings.engine)) throw new Error("bb.error.invalidEngine")
  const audioModel = settings.audioModel ?? AUDIO_DEFAULT_MODEL
  const audioLanguage = settings.audioLanguage ?? ""
  if (!MODEL_ID.test(audioModel)) throw new Error("bb.error.audioModel")
  if (audioLanguage !== "" && !LANGUAGE.test(audioLanguage)) throw new Error("bb.error.audioLanguage")
  return { engine: settings.engine, audioModel, audioLanguage }
}

// Previous cloud selection is retired without sending old audio to a new paid provider.
export function migrateAudioPreferences(settings: Record<string, unknown>) {
  const engine: Engine = settings.engine === "groq" ? "parakeet" : (settings.engine as Engine)
  return audioPreferences({
    engine: engine ?? "parakeet",
    audioModel:
      typeof settings.audioModel === "string" && MODEL_ID.test(settings.audioModel) ? settings.audioModel : undefined,
    audioLanguage:
      typeof settings.audioLanguage === "string" && LANGUAGE.test(settings.audioLanguage)
        ? settings.audioLanguage
        : undefined,
  })
}

export async function audioModels(request: typeof fetch = fetch): Promise<AudioModel[]> {
  const response = await request("https://openrouter.ai/api/v1/models?output_modalities=transcription", {
    signal: AbortSignal.timeout(20_000),
  }).catch(() => {
    throw new Error("bb.error.audioModelsUnavailable")
  })
  if (!response.ok) throw new Error("bb.error.audioModelsUnavailable")
  const body: unknown = await response.json().catch(() => undefined)
  if (!stateRecord(body) || !Array.isArray(body.data)) throw new Error("bb.error.audioModelsUnavailable")
  const models = body.data
    .filter(
      (row): row is Record<string, unknown> =>
        stateRecord(row) &&
        typeof row.id === "string" &&
        typeof row.name === "string" &&
        stateRecord(row.architecture) &&
        Array.isArray(row.architecture.input_modalities) &&
        row.architecture.input_modalities.includes("audio") &&
        Array.isArray(row.architecture.output_modalities) &&
        row.architecture.output_modalities.includes("transcription"),
    )
    .map((row) => ({ id: String(row.id), name: String(row.name) }))
  if (!models.length) throw new Error("bb.error.audioModelsUnavailable")
  return [...new Map(models.map((row) => [row.id, row])).values()].sort((a, b) => a.name.localeCompare(b.name))
}
