import type { ConversationWindowTarget } from "@opencode-ai/app/conversation-window"

/** Window targets carry identities only; credentials stay in the existing server store. */
export function parseConversationWindowTarget(value: unknown): ConversationWindowTarget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  if (!("server" in value) || !("sessionID" in value) || !("directory" in value)) return
  if (typeof value.server !== "string" || typeof value.sessionID !== "string" || typeof value.directory !== "string")
    return
  if (!value.server || value.server.length > 2048 || /[\x00-\x1f]/.test(value.server)) return
  if (!/^ses_[a-zA-Z0-9_-]{1,160}$/.test(value.sessionID)) return
  if (!value.directory || value.directory.length > 32768 || /[\x00-\x1f]/.test(value.directory)) return
  if (!/^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\|\/)/.test(value.directory)) return
  if (/^https?:\/\//.test(value.server)) {
    if (!URL.canParse(value.server)) return
    const url = new URL(value.server)
    if (url.username || url.password || url.hash || url.search) return
  } else if (value.server !== "sidecar" && !/^(?:wsl|ssh):[^\s]+$/.test(value.server)) return
  return {
    server: value.server as ConversationWindowTarget["server"],
    sessionID: value.sessionID,
    directory: value.directory,
  }
}

export function createConversationWindowTargets<T extends object>() {
  const targets = new WeakMap<T, ConversationWindowTarget>()
  return {
    seed(window: T, target: ConversationWindowTarget) {
      targets.set(window, { ...target })
    },
    consume(window: T) {
      const target = targets.get(window)
      targets.delete(window)
      return target ?? null
    },
  }
}
