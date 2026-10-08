import { executionOwner } from "@opencode-ai/core/execution-owner"

type Assistant = {
  id: string
  role: string
  parentID?: string
  time?: { created?: number; completed?: number }
  error?: unknown
}

/** Stored part status is historical evidence, never proof of a live execution. */
export function ownsAssistant(status: unknown, message: Assistant) {
  if (message.role !== "assistant" || message.error || typeof message.time?.completed === "number") return false
  if (
    !status ||
    typeof status !== "object" ||
    !("type" in status) ||
    !["busy", "retry", "running"].includes(String(status.type))
  )
    return false
  if (!("owner" in status) || !status.owner || typeof status.owner !== "object") return false
  const owner = executionOwner(status.owner)
  return !!owner && owner.assistantID === message.id && (!message.parentID || owner.inputID === message.parentID)
}

export function ownsPart(
  status: unknown,
  part: { messageID: string; state?: { status: string }; time?: { end?: number } },
) {
  if (typeof part.time?.end === "number") return false
  return ownsAssistant(status, { id: part.messageID, role: "assistant" })
}

export function displayedToolStatus(status: string, active: boolean) {
  return !active && (status === "pending" || status === "running") ? "interrupted" : status
}
