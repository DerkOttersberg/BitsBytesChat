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
  }
  return keys[name]
}
