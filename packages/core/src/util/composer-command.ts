// Mode commands may be inserted into prose at the caret, but code and paths
// remain literal. Other slash commands keep their existing start-of-input rule.
export function composerCommand(text: string, cursor = text.length) {
  const end = Math.max(0, Math.min(cursor, text.length))
  const before = text.slice(0, end)
  const match = before.match(/(?:^|\s)\/(\S*)$/)
  if (!match) return undefined
  const query = match[1]
  const start = end - query.length - 1
  if (start && !["plan", "goal"].some((command) => command.startsWith(query))) return undefined
  // Backtick/tilde fences and inline code are not command entry points.
  let fence = "",
    ticks = false
  for (const line of before.slice(0, start).split("\n")) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)
    if (marker) {
      const char = marker[1][0]
      fence = fence === char ? "" : fence || char
      continue
    }
    if (!fence && (line.match(/(?<!\\)`/g)?.length ?? 0) % 2) ticks = !ticks
  }
  if (fence || ticks) return undefined
  return { start, end, query }
}

export function removeComposerCommand<T extends { type: string; content?: string; start?: number; end?: number }>(
  parts: T[],
  token: { start: number; end: number },
) {
  let offset = 0,
    nextOffset = 0
  const prompt = parts.map((part) => {
    if (typeof part.content !== "string") return { ...part }
    const start = offset
    offset += part.content.length
    const content =
      part.type === "text" && offset > token.start && start < token.end
        ? part.content.slice(0, Math.max(0, token.start - start)) + part.content.slice(Math.max(0, token.end - start))
        : part.content
    const next = { ...part, content, start: nextOffset, end: nextOffset + content.length }
    nextOffset += content.length
    return next
  })
  return { prompt, cursor: token.start }
}
