import { afterEach, expect, test } from "bun:test"
import { createServer } from "node:http"
import {
  AUDIO_DEFAULT_MODEL,
  audioModels,
  audioPreferences,
  migrateAudioPreferences,
  openrouterAudioKey,
} from "./bitsbytes-audio"

const servers: ReturnType<typeof createServer>[] = []
afterEach(() => {
  servers.splice(0).forEach((server) => server.close())
})

async function catalogue(body: unknown, status = 200) {
  const server = createServer((_request, response) =>
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)),
  )
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No fixture address")
  return (url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    expect(String(url)).toBe("https://openrouter.ai/api/v1/models?output_modalities=transcription")
    return fetch(`http://127.0.0.1:${address.port}`, options)
  }
}

test("dedicated audio catalogue accepts zero-context transcription models without chat tools", async () => {
  const model = {
    id: AUDIO_DEFAULT_MODEL,
    name: "Whisper Turbo",
    context_length: 0,
    supported_parameters: [],
    architecture: { input_modalities: ["audio"], output_modalities: ["transcription"] },
  }
  const request = await catalogue({
    data: [
      model,
      model,
      { ...model, id: "chat-only", architecture: { input_modalities: ["audio"], output_modalities: ["text"] } },
      { id: "malformed" },
    ],
  })
  expect(await audioModels(request)).toEqual([{ id: AUDIO_DEFAULT_MODEL, name: "Whisper Turbo" }])
})

test("failed or damaged discovery stays actionable instead of advertising chat models", async () => {
  for (const body of [{ data: [] }, { data: "broken" }, { error: "fixture" }])
    await expect(audioModels(await catalogue(body))).rejects.toThrow("bb.error.audioModelsUnavailable")
  await expect(audioModels(await catalogue({}, 503))).rejects.toThrow("bb.error.audioModelsUnavailable")
})

test("audio selection is separate, validated and retains recommended defaults", () => {
  expect(audioPreferences({ engine: "openrouter" })).toEqual({
    engine: "openrouter",
    audioModel: AUDIO_DEFAULT_MODEL,
    audioLanguage: "",
  })
  expect(
    audioPreferences({ engine: "openrouter", audioModel: "openai/gpt-4o-mini-transcribe", audioLanguage: "nl" })
      .audioLanguage,
  ).toBe("nl")
  expect(() => audioPreferences({ engine: "openrouter", audioModel: "chat-model" })).toThrow("bb.error.audioModel")
  expect(() => audioPreferences({ engine: "openrouter", audioLanguage: "Dutch" })).toThrow("bb.error.audioLanguage")
})

test("retired cloud selection migrates to local without replacing historical recording data", () => {
  const saved = { engine: "groq", model: "chat-model", provider: "chatgpt", microphone: 3 }
  const result = migrateAudioPreferences(saved)
  expect(result).toEqual({ engine: "parakeet", audioModel: AUDIO_DEFAULT_MODEL, audioLanguage: "" })
  expect(saved).toEqual({ engine: "groq", model: "chat-model", provider: "chatgpt", microphone: 3 })
  expect(migrateAudioPreferences(result)).toEqual(result)
  expect(migrateAudioPreferences({ engine: "openrouter", audioModel: "damaged", audioLanguage: 5 })).toEqual({
    engine: "openrouter",
    audioModel: AUDIO_DEFAULT_MODEL,
    audioLanguage: "",
  })
})

test("existing encrypted OpenRouter API connections are reused across both credential formats", () => {
  expect(openrouterAudioKey({ openrouter: " fixture-top " })).toBe("fixture-top")
  expect(openrouterAudioKey({ providers: { openrouter: { type: "api", key: "fixture-v1" } } })).toBe("fixture-v1")
  expect(
    openrouterAudioKey({
      nativeCredentials: [
        { integrationID: "openrouter", value: { type: "key", key: "fixture-v2", metadata: { preserved: true } } },
      ],
    }),
  ).toBe("fixture-v2")
  expect(
    openrouterAudioKey({
      nativeCredentials: [{ integrationID: "chatgpt", value: { type: "oauth", access: "not-an-audio-key" } }],
    }),
  ).toBeUndefined()
  expect(
    openrouterAudioKey({ openrouter: " ", providers: { openrouter: { type: "oauth", access: "not-an-audio-key" } } }),
  ).toBeUndefined()
})
