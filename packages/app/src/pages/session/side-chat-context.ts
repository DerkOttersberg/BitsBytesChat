// The engine keeps the complete fork. Only the inherited timeline is hidden.
export function sideChatContextKey(directory: string, sessionID: string) {
  return `bitsbytes.side-context.v1:${directory}:${sessionID}`
}

export function sideChatContextBoundary(directory: string, sessionID?: string) {
  if (!sessionID) return undefined
  const value = Number(localStorage.getItem(sideChatContextKey(directory, sessionID)))
  return Number.isFinite(value) && value > 0 ? value : undefined
}

export function afterInheritedContext<T extends { time: { created: number } }>(messages: T[], before?: number) {
  return before === undefined ? messages : messages.filter(message => message.time.created >= before)
}
