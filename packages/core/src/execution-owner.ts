import type { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"

/** Narrow process ownership received from an attachment without trusting cached parts. */
export function executionOwner(value: unknown): SessionStatusEvent.Owner | undefined {
  if (!value || typeof value !== "object") return
  const owner = value as Record<string, unknown>
  const valid = (id: unknown): id is string =>
    typeof id === "string" && !!id && id.length <= 256 && !/[\r\n\0]/.test(id)
  if (!valid(owner.runEpoch) || !valid(owner.inputID) || (owner.assistantID !== undefined && !valid(owner.assistantID)))
    return
  return {
    runEpoch: owner.runEpoch,
    inputID: owner.inputID,
    ...(owner.assistantID === undefined ? {} : { assistantID: owner.assistantID }),
  }
}
