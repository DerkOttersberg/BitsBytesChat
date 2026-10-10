import type { AudioModel, Settings } from "../bitsbytes/types"
import { AUDIO_DEFAULT_MODEL, audioSupportsDiarization } from "../bitsbytes/audio"
import { stateRecord } from "./bitsbytes-state"
import { providerApiKey } from "./bitsbytes-credentials"

export { AUDIO_DEFAULT_MODEL } from "../bitsbytes/audio"
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]{0,180}$/i
const LANGUAGE = /^[a-z]{2}$/

export async function verifyAudioConnection(key: string | undefined, request: typeof fetch = fetch) {
  if (!key?.trim()) throw new Error("bb.error.audioKeyMissing")
  const response = await request("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new Error("bb.error.audioConnectionUnavailable")
  })
  if (response.status === 401 || response.status === 403) throw new Error("bb.error.audioConnectionRejected")
  if (response.status === 402) throw new Error("bb.error.audioConnectionCredits")
  if (response.status === 429) throw new Error("bb.error.audioConnectionRateLimit")
  if (!response.ok) throw new Error("bb.error.audioConnectionUnavailable")
  const result: unknown = await response.json().catch(() => undefined)
  if (!stateRecord(result) || !stateRecord(result.data)) throw new Error("bb.error.audioConnectionUnavailable")
}

export function openrouterAudioKey(credentials: {
  openrouter?: string
  providers?: Record<string, unknown>
  nativeCredentials?: { integrationID: string; value: unknown }[]
}) {
  return providerApiKey(credentials, "openrouter")
}

export function audioPreferences(
  settings: Pick<Settings, "engine" | "audioModel" | "audioLanguage" | "audioDiarization">,
) {
  if (!["parakeet", "whisper", "openrouter"].includes(settings.engine)) throw new Error("bb.error.invalidEngine")
  const audioModel = settings.audioModel ?? AUDIO_DEFAULT_MODEL
  const audioLanguage = settings.audioLanguage ?? ""
  if (!MODEL_ID.test(audioModel)) throw new Error("bb.error.audioModel")
  if (audioLanguage !== "" && !LANGUAGE.test(audioLanguage)) throw new Error("bb.error.audioLanguage")
  if (settings.audioDiarization !== undefined && typeof settings.audioDiarization !== "boolean")
    throw new Error("bb.error.invalidSettings")
  const audioDiarization =
    settings.engine === "openrouter" && audioSupportsDiarization(audioModel) && settings.audioDiarization !== false
  return { engine: settings.engine, audioModel, audioLanguage, audioDiarization }
}

// Changes future recordings only. Historical audio and jobs are never submitted on migration.
export function migrateAudioPreferences(settings: Record<string, unknown>) {
  return audioPreferences({
    engine: "openrouter",
    audioModel:
      settings.engine === "openrouter" && typeof settings.audioModel === "string" && MODEL_ID.test(settings.audioModel)
        ? settings.audioModel
        : undefined,
    audioLanguage:
      typeof settings.audioLanguage === "string" && LANGUAGE.test(settings.audioLanguage)
        ? settings.audioLanguage
        : undefined,
    audioDiarization: typeof settings.audioDiarization === "boolean" ? settings.audioDiarization : undefined,
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
