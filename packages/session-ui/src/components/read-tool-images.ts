import type { FilePart } from "@opencode-ai/sdk/v2"

export type RecordedReadImage = Pick<FilePart, "mime" | "url" | "filename"> & { attachmentIndex: number }
export type ReadImageState = { status?: unknown; attachments?: unknown }

const supported = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])
const empty: readonly RecordedReadImage[] = []

// A read filename is not proof that an image was viewed. Render only the
// completed tool's recorded image bytes, never the current source file.
export function readToolImages(state: ReadImageState | undefined): readonly RecordedReadImage[] {
  if (state?.status !== "completed" || !Array.isArray(state.attachments)) return empty
  return state.attachments.flatMap((attachment, attachmentIndex): RecordedReadImage[] => {
    if (!attachment || typeof attachment !== "object") return []
    if (attachment.type !== "file" || typeof attachment.mime !== "string" || !supported.has(attachment.mime))
      return []
    if (typeof attachment.url !== "string") return []
    const prefix = `data:${attachment.mime};base64,`
    return (
      attachment.url.startsWith(prefix) &&
      attachment.url.length > prefix.length &&
      (attachment.filename === undefined || typeof attachment.filename === "string")
    ) ? [{ mime: attachment.mime, url: attachment.url, filename: attachment.filename, attachmentIndex }] : []
  })
}
