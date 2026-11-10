import { AppError, copy } from "./copy.js"
import type { SpeakerTurn } from "./shared.js"

export function supportsSpeakers(model: string) {
  return ["elevenlabs/scribe-v2", "elevenlabs/scribe-v2-medical"].includes(model)
}
export function speakerName(speaker: number) {
  return speaker < 0 ? copy.unknownSpeaker : copy.speaker.replace("{number}", String(speaker + 1))
}
export function speakerTranscript(turns: SpeakerTurn[]) {
  return turns.map(turn => `${speakerName(turn.speaker)}: ${turn.text}`).join("\n\n")
}
export function parseSpeakers(result: Record<string, unknown>, duration: number): SpeakerTurn[] {
  const labeled = (rows: unknown) => Array.isArray(rows) && rows.some(row => row && typeof row === "object" && [row.speaker, row.speaker_id, row.speaker_label].some(value => typeof value === "string" || typeof value === "number"))
  const words = labeled(result.words)
  const rows: unknown[] = words ? result.words as unknown[] : labeled(result.segments) ? result.segments as unknown[] : []
  if (!rows.length) throw new AppError("speakerResponse")
  const identities = new Map<string, number>()
  const turns: SpeakerTurn[] = []
  for (const value of rows) {
    if (!value || typeof value !== "object") throw new AppError("speakerResponse")
    const row = value as Record<string, unknown>
    if (row.type === "spacing" || row.type === "audio_event") continue
    const text = typeof row.word === "string" ? row.word.trim() : typeof row.text === "string" ? row.text.trim() : ""
    if (!text) continue
    if (typeof row.start !== "number" || typeof row.end !== "number" || !Number.isFinite(row.start) || !Number.isFinite(row.end) || row.start < 0 || row.end < row.start || row.end > duration + 2) throw new AppError("speakerResponse")
    const raw = row.speaker ?? row.speaker_id ?? row.speaker_label
    if (typeof raw === "number" && (!Number.isSafeInteger(raw) || raw < 0)) throw new AppError("speakerResponse")
    if (typeof raw === "string" && (raw.length > 128 || !raw.trim())) throw new AppError("speakerResponse")
    const identity = typeof raw === "number" || typeof raw === "string" ? String(raw) : undefined
    if (identity !== undefined && !identities.has(identity)) identities.set(identity, identities.size)
    const speaker = identity === undefined ? -1 : identities.get(identity)!
    const previous = turns.at(-1)
    if (previous && words && previous.speaker === speaker && row.start - previous.end < 2) {
      previous.text = `${previous.text} ${text}`.replace(/\s+([,.;:!?…])/g, "$1")
      previous.end = Math.max(previous.end, row.end)
      continue
    }
    turns.push({ speaker, start: row.start, end: row.end, text })
  }
  if (!identities.size || !turns.length) throw new AppError("speakerResponse")
  return turns
}
