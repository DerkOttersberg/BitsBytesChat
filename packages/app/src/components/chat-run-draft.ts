import type { ContentPart, ImageAttachmentPart } from "../context/prompt-state"
import type { BlobReference } from "../utils/draft-store"
import { createLegacyBlobReference } from "../utils/draft-store"
import type { FollowupDraft } from "./prompt-input/submit"

type SavedImage = Omit<ImageAttachmentPart, "id" | "blob"> & { id?: string; blob?: BlobReference; dataUrl?: string }
export type QueuedDraft = Omit<FollowupDraft, "prompt"> & {
  prompt: (Exclude<ContentPart, ImageAttachmentPart> | SavedImage)[]
}

// The frozen engine request remains authoritative. Optional editing metadata
// must be safe before it reaches composer operations or queue labels.
export function readQueuedDraft(value: unknown): QueuedDraft | undefined {
  if (
    !record(value) ||
    typeof value.sessionID !== "string" ||
    typeof value.sessionDirectory !== "string" ||
    typeof value.agent !== "string" ||
    !record(value.model) ||
    typeof value.model.providerID !== "string" ||
    typeof value.model.modelID !== "string" ||
    (value.variant !== undefined && typeof value.variant !== "string") ||
    !Array.isArray(value.prompt) ||
    !Array.isArray(value.context)
  )
    return
  if (
    !value.prompt.every((part) => {
      if (!record(part)) return false
      if (part.type === "image")
        return (
          typeof part.filename === "string" &&
          typeof part.mime === "string" &&
          (part.dataUrl === undefined || (typeof part.dataUrl === "string" && part.dataUrl.startsWith("data:"))) &&
          (part.sourcePath === undefined || typeof part.sourcePath === "string") &&
          ((typeof part.dataUrl === "string" && part.dataUrl.startsWith("data:")) ||
            (record(part.blob) && typeof part.blob.id === "string" && typeof part.blob.url === "string")) &&
          (part.id === undefined || typeof part.id === "string")
        )
      if (typeof part.content !== "string" || !Number.isFinite(part.start) || !Number.isFinite(part.end)) return false
      if (part.type === "text") return true
      if (part.type === "agent") return typeof part.name === "string"
      return (
        part.type === "file" &&
        typeof part.path === "string" &&
        selection(part.selection) &&
        ["mime", "filename", "url"].every((key) => part[key] === undefined || typeof part[key] === "string")
      )
    })
  )
    return
  if (
    !value.context.every(
      (item) =>
        record(item) &&
        item.type === "file" &&
        typeof item.path === "string" &&
        typeof item.key === "string" &&
        selection(item.selection) &&
        ["comment", "commentID", "preview"].every((key) => item[key] === undefined || typeof item[key] === "string") &&
        (item.commentOrigin === undefined || item.commentOrigin === "review" || item.commentOrigin === "file") &&
        (item.attachment === undefined ||
          (record(item.attachment) &&
            (item.attachment.kind === "transcript" || item.attachment.kind === "skill") &&
            typeof item.attachment.id === "string" &&
            typeof item.attachment.name === "string" &&
            (item.attachment.revision === undefined ||
              (Number.isInteger(item.attachment.revision) && Number(item.attachment.revision) >= 0)))),
    )
  )
    return
  return value as QueuedDraft
}

export function restoreQueuedDraft(draft: QueuedDraft): FollowupDraft {
  const ids = new Set<string>()
  return {
    ...draft,
    prompt: draft.prompt.map((part) => {
      if (part.type !== "image") return part
      const id = part.id && !ids.has(part.id) ? part.id : crypto.randomUUID()
      ids.add(id)
      return { ...part, id, blob: part.dataUrl ? createLegacyBlobReference(part.dataUrl) : part.blob! }
    }),
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function selection(value: unknown) {
  return (
    value === undefined ||
    (record(value) &&
      ["startLine", "startChar", "endLine", "endChar"].every(
        (key) => Number.isInteger(value[key]) && Number(value[key]) >= 0,
      ))
  )
}
