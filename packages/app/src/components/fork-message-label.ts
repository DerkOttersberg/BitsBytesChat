import type { Part } from "@opencode-ai/sdk/v2"

export function forkMessageLabel(parts: readonly Part[], attachmentName: string) {
  const text = parts.find((part) => part.type === "text" && !part.synthetic && !part.ignored)
  if (text?.type === "text" && text.text.trim()) return text.text.replace(/\n/g, " ").slice(0, 200)
  const file = parts.find((part) => part.type === "file")
  if (file?.type !== "file") return
  return (file.filename?.trim() ? file.filename : attachmentName).replace(/\n/g, " ").slice(0, 200)
}
