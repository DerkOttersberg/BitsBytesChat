import type { ToolPart } from "@opencode-ai/sdk/v2"

export function isImageGenerationTool(part: ToolPart) {
  if (part.tool === "bitsbytes-local_generate_image") return true
  if (part.tool !== "code_mode" || !("metadata" in part.state)) return false
  const calls: unknown = part.state.metadata?.toolCalls
  if (!Array.isArray(calls) || !calls.length) return false
  const names = calls.map((call: unknown) =>
    call && typeof call === "object" && "tool" in call ? call.tool : undefined,
  )
  return (
    names.includes("bitsbytes-local.generate_image") &&
    names.every((name) => name === "bitsbytes-local.generate_image" || name === "bitsbytes-local.image_capabilities")
  )
}

/** Only local tools with known semantics receive product labels. */
export function toolPresentationKey(tool: string) {
  const name = tool.startsWith("bitsbytes-local_") ? tool.slice("bitsbytes-local_".length) : tool
  const keys: Record<string, string> = {
    create_artifact: "ui.tool.artifact.create",
    create_word: "ui.tool.artifact.create",
    create_intake: "ui.tool.artifact.create",
    run_artifact_script: "ui.tool.artifact.script",
    publish_artifact: "ui.tool.artifact.publish",
    read_artifact_pages: "ui.tool.artifact.pages",
    inspect_artifact: "ui.tool.artifact.inspect",
    generate_image: "ui.tool.image.generate",
    image_capabilities: "ui.tool.image.capabilities",
  }
  return keys[name]
}
