export const AUDIO_DEFAULT_MODEL = "elevenlabs/scribe-v2"

// Verified provider capability; chat availability alone must not imply diarization.
export function audioSupportsDiarization(model?: string) {
  return model === "elevenlabs/scribe-v2" || model === "elevenlabs/scribe-v2-medical"
}
