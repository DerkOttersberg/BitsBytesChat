import type { QueuedDraft } from "./chat-run-draft"
import type { FollowupDraft } from "./prompt-input/submit"

export type QueuedEditComposer = {
  prompt: readonly FollowupDraft["prompt"][number][]
  context: readonly FollowupDraft["context"][number][]
} & Partial<Pick<FollowupDraft, "agent" | "model" | "variant">>
export type QueuedEditPrior = QueuedEditComposer & { sessionID: string }

// A saved selection stays authoritative while its provider/catalog is absent.
// Explicit default variants and different saved IDs must remain distinguishable.
export function queuedEditSelection(input: {
  selectedAgent?: string
  resolvedAgent?: string
  selectedModel?: FollowupDraft["model"]
  resolvedModel?: FollowupDraft["model"]
  selectedVariant?: string | null
  resolvedVariant?: string
}) {
  const model = input.selectedModel ?? input.resolvedModel
  return {
    agent: input.selectedAgent ?? input.resolvedAgent,
    model: model ? { providerID: model.providerID, modelID: model.modelID } : undefined,
    variant: input.selectedVariant === null ? undefined : (input.selectedVariant ?? input.resolvedVariant),
  }
}

export function createQueuedEditGuard() {
  let selected = "",
    generation = 0
  const select = (sessionID: string) => {
    if (selected === sessionID) return false
    selected = sessionID
    generation++
    return true
  }
  return {
    select,
    begin(sessionID: string) {
      select(sessionID)
      return { sessionID, generation: ++generation }
    },
    current(request: { sessionID: string; generation: number }, sessionID: string) {
      select(sessionID)
      return request.sessionID === selected && request.generation === generation
    },
    invalidate() {
      generation++
    },
  }
}

// A recovered reservation has no renderer-local rollback snapshot. Clear only
// its unchanged copied source; never erase a newer draft while Cancel awaits IPC.
export function queuedEditCancelAction(input: {
  sessionID: string
  current: QueuedEditComposer
  before: QueuedEditComposer
  prior?: QueuedEditPrior
  queued?: QueuedDraft
}): "restore" | "clear" | "preserve" {
  if (JSON.stringify(canonical(input.current)) !== JSON.stringify(canonical(input.before))) return "preserve"
  if (input.prior?.sessionID === input.sessionID) return "restore"
  if (input.queued?.sessionID !== input.sessionID) return "preserve"
  const copied = (value: QueuedEditComposer | QueuedDraft) => ({
    ...value,
    sessionID: undefined,
    sessionDirectory: undefined,
    prompt: value.prompt.map((part) => {
      if (part.type === "text") return { type: part.type, content: part.content }
      if (part.type === "agent") return { type: part.type, name: part.name }
      if (part.type === "file")
        return {
          type: part.type,
          path: part.path,
          mime: part.mime,
          filename: part.filename,
          url: part.url,
          selection: part.selection,
        }
      return { type: part.type, id: part.id, mime: part.mime, filename: part.filename }
    }),
  })
  if (input.queued.prompt.some((part) => part.type === "image" && !part.id)) return "preserve"
  return JSON.stringify(canonical(copied(input.current))) === JSON.stringify(canonical(copied(input.queued)))
    ? "clear"
    : "preserve"
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    )
  return value
}

// Reorder the visible neighbors without dropping the durable original that
// is currently being edited in the composer.
export function moveQueuedInput(queue: { id: string; editing?: boolean; status?: string; presentation?: string }[], id: string, step: -1 | 1) {
  const visible = queue.filter((item) => !item.editing && item.status !== "sending" && item.presentation !== "transcript")
  const selected = visible.findIndex((item) => item.id === id)
  const neighbor = visible[selected + step]
  if (selected < 0 || !neighbor) return
  const ids = queue.map((item) => item.id)
  const from = ids.indexOf(id),
    to = ids.indexOf(neighbor.id)
  ;[ids[from], ids[to]] = [ids[to], ids[from]]
  return ids
}

export function reorderQueuedInput(queue: { id: string; editing?: boolean; status?: string; presentation?: string }[], id: string, target: string) {
  const visible = queue.filter(row => !row.editing && row.status !== "sending" && row.presentation !== "transcript")
  const from = visible.findIndex(row => row.id === id), to = visible.findIndex(row => row.id === target)
  if (from < 0 || to < 0 || from === to) return
  const moved = [...visible]
  moved.splice(to, 0, ...moved.splice(from, 1))
  let position = 0
  return queue.map(row => visible.includes(row) ? moved[position++].id : row.id)
}
