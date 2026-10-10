import type { AssistantMessage, Message, Part, SessionStatus } from "@opencode-ai/sdk/v2"
import { readToolImages } from "@opencode-ai/session-ui/read-tool-images"
import { isImageGenerationTool } from "@opencode-ai/session-ui/tool-presentation"
import { TimelineRow } from "./timeline-row"

/** Fold presentation only; the original messages and tool results remain untouched. */
export function completedWork(input: {
  rows: TimelineRow.TimelineRow[]
  messages: Map<string, Message>
  parts: (id: string) => Part[]
  status: SessionStatus["type"]
  activeMessageID?: string
  expanded: Record<string, boolean | undefined>
}) {
  const turns = new Map<string, TimelineRow.TimelineRow[]>()
  const assistantsByParent = new Map<string, AssistantMessage[]>()
  input.messages.forEach((message) => {
    if (message.role !== "assistant") return
    const assistants = assistantsByParent.get(message.parentID)
    if (assistants) assistants.push(message)
    if (!assistants) assistantsByParent.set(message.parentID, [message])
  })
  input.rows.forEach((row) => {
    const rows = turns.get(row.userMessageID)
    if (rows) rows.push(row)
    if (!rows) turns.set(row.userMessageID, [row])
  })
  return [...turns.values()].flatMap((rows) => {
    const id = rows[0]!.userMessageID
    if (id === input.activeMessageID && input.status !== "idle") return rows
    const assistants = assistantsByParent.get(id) ?? []
    const last = assistants.at(-1)
    if (!last || last.error || typeof last.time.completed !== "number" || last.finish === "tool-calls") return rows
    const final = input.parts(last.id)
    if (!final.some((part) => part.type === "text" && part.text.trim())) return rows
    if (
      final.some((part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"))
    )
      return rows
    if (rows.some((row) => row._tag === "Error" || row._tag === "Thinking" || row._tag === "Retry")) return rows
    const parts = new Map(
      assistants.flatMap((message) => input.parts(message.id).map((part) => [part.id, part] as const)),
    )
    const history = rows.filter((row) => {
      if (row._tag !== "AssistantPart") return false
      if (row.group.type === "context") return true
      const part = parts.get(row.group.ref.partID)
      if (!part) return false
      if (part.type === "text") return row.group.ref.messageID !== last.id
      if (part.type === "reasoning") return true
      if (part.type !== "tool" || part.tool === "question" || isImageGenerationTool(part)) return false
      return !(part.tool === "read" && readToolImages(part.state).length)
    })
    if (!history.length) return rows
    const historyKeys = new Set(history.map(TimelineRow.key))
    const refs = history.flatMap((row) =>
      row._tag !== "AssistantPart" ? [] : row.group.type === "context" ? row.group.refs : [row.group.ref],
    )
    const user = input.messages.get(id)
    const elapsedMs =
      user?.role === "user" && last.time.completed >= user.time.created
        ? last.time.completed - user.time.created
        : undefined
    const expanded = input.expanded[`work:${id}`] === true
    const summary = new TimelineRow.WorkSummary({
      userMessageID: id,
      elapsedMs,
      count: refs.length,
      expanded,
      failures: refs.filter((ref) => {
        const part = parts.get(ref.partID)
        return part?.type === "tool" && part.state.status === "error"
      }).length,
    })
    return rows.flatMap((row) => {
      if (row === history[0]) return expanded ? [summary, row] : [summary]
      if (!expanded && historyKeys.has(TimelineRow.key(row))) return []
      return [row]
    })
  })
}
