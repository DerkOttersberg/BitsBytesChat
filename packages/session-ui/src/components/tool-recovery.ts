import { ToolOperation } from "@opencode-ai/core/tool-operation"

type Item = {
  messageID: string
  part: { id: string; type: string; tool?: string; state?: { status: string; metadata?: unknown } }
}

/** Group only an explicit failed-attempt chain whose exact output was verified. */
export function recoveredToolAttempts(items: readonly Item[]) {
  const attempts = new Map<string, { item: Item; info: ToolOperation.Info }>()
  for (const item of items) {
    if (item.part.type !== "tool" || !item.part.state) continue
    const info = ToolOperation.metadata(item.part.state.metadata)
    if (info) attempts.set(info.attemptID, { item, info })
  }
  const recovered = new Map<string, { messageID: string; partID: string }[]>()
  const hidden = new Set<string>()
  for (const { item, info } of attempts.values()) {
    if (item.part.state?.status !== "completed" || !info.artifacts?.length) continue
    const refs: { messageID: string; partID: string }[] = []
    const seen = new Set<string>([info.attemptID])
    let retryOf = info.retryOf
    while (retryOf && !seen.has(retryOf)) {
      seen.add(retryOf)
      const previous = attempts.get(retryOf)
      if (
        !previous ||
        previous.item.part.state?.status !== "error" ||
        previous.info.operationID !== info.operationID ||
        previous.info.sessionID !== info.sessionID ||
        previous.info.tool !== info.tool ||
        previous.info.outputKey !== info.outputKey ||
        previous.item.part.tool !== item.part.tool
      )
        break
      refs.unshift({ messageID: previous.item.messageID, partID: previous.item.part.id })
      hidden.add(previous.item.part.id)
      retryOf = previous.info.retryOf
    }
    if (refs.length) recovered.set(item.part.id, refs)
  }
  return { recovered, hidden }
}
