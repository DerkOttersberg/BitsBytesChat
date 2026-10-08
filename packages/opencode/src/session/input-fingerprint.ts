import { createHash } from "node:crypto"

// Request key order and retry controls are not part of the frozen input.
export function inputFingerprint(input: Record<string, unknown>) {
  const { sessionID, messageID, noReply, resume, revision, ...payload } = input
  return createHash("sha256")
    .update(JSON.stringify(canonical(payload)))
    .digest("hex")
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, canonical(value)]),
  )
}
