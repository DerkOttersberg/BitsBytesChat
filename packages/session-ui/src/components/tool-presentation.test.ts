import { expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { isImageGenerationTool } from "./tool-presentation"

const part = (names: string[]): ToolPart => ({
  id: "prt_fixture",
  sessionID: "ses_fixture",
  messageID: "msg_fixture",
  callID: "call_fixture",
  type: "tool",
  tool: "code_mode",
  state: {
    status: "running",
    input: {},
    time: { start: 1 },
    metadata: { toolCalls: names.map((tool) => ({ tool, status: "running" })) },
  },
})

test("image-only Code Mode activity is represented by the image card", () => {
  expect(isImageGenerationTool(part(["bitsbytes-local.generate_image"]))).toBe(true)
  expect(isImageGenerationTool(part(["bitsbytes-local.image_capabilities", "bitsbytes-local.generate_image"]))).toBe(
    true,
  )
  expect(isImageGenerationTool({ ...part([]), tool: "bitsbytes-local_generate_image" })).toBe(true)
})

test("non-image and mixed Code Mode activity retains its normal tool transcript", () => {
  expect(isImageGenerationTool(part([]))).toBe(false)
  expect(isImageGenerationTool(part(["bitsbytes-local.image_capabilities"]))).toBe(false)
  expect(isImageGenerationTool(part(["bitsbytes-local.generate_image", "documents.publish"]))).toBe(false)
  expect(isImageGenerationTool(part(["documents.publish"]))).toBe(false)
})
