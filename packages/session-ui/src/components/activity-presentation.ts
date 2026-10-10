import type { Part, ToolPart } from "@opencode-ai/sdk/v2"
import { readToolImages } from "./read-tool-images"

/** Only known activities collapse. Images, questions and unresolved errors stay visible. */
export function activityCategory(part: Part): number {
  if (part.type !== "tool" || part.state.status === "error") return 0
  if (/^windows-control[_.]PowerShell$/i.test(part.tool)) return 4
  if (/^windows-control[_.]FileSystem$/i.test(part.tool)) return 16
  if (part.tool === "read" && readToolImages(part.state).length) return 0
  if (["read", "glob", "grep", "list"].includes(part.tool)) return 1
  if (["edit", "write", "patch", "apply_patch"].includes(part.tool)) return 2
  if (["bash", "shell"].includes(part.tool)) return 4
  if (["websearch", "webfetch", "codesearch"].includes(part.tool)) return 8
  return 0
}

export function activitySummary(parts: readonly ToolPart[]) {
  const mask = parts.reduce((value, part) => value | activityCategory(part), 0)
  return {
    key: mask & 16 ? `ui.activity.summary.files.${mask & 12}` : `ui.activity.summary.${mask}`,
    icon:
      mask & 16
        ? ("folder" as const)
        : mask & 2
          ? ("pencil-line" as const)
          : mask & 4
            ? ("console" as const)
            : mask & 8
              ? ("window-cursor" as const)
              : ("magnifying-glass-menu" as const),
  }
}
