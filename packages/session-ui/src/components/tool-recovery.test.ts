import { expect, test } from "bun:test"
import { recoveredToolAttempts } from "./tool-recovery"
import { toolPresentationKey } from "./tool-presentation"

function item(id: string, status: string, override: Record<string, unknown> = {}) {
  return {
    messageID: "assistant-" + id,
    part: {
      id,
      type: "tool",
      tool: "bitsbytes-local_create_artifact",
      state: {
        status,
        metadata: {
          "bitsbytes.operation": {
            operationID: "op",
            attemptID: id,
            sessionID: "chat",
            tool: "create_artifact",
            outputKey: "output",
            ...override,
          },
        },
      },
    },
  }
}
const artifact = { id: "artifact", revision: 2, hash: "verified-hash" }

test("an explicit verified retry groups the exact failed chain in source order", () => {
  const first = item("first", "error"),
    second = item("second", "error", { retryOf: "first" })
  const success = item("success", "completed", { retryOf: "second", artifacts: [artifact] })
  const grouped = recoveredToolAttempts([first, second, success])
  expect([...grouped.hidden]).toEqual(["second", "first"])
  expect(grouped.recovered.get("success")).toEqual([
    { messageID: "assistant-first", partID: "first" },
    { messageID: "assistant-second", partID: "second" },
  ])
})

test("pending, preparing, unverified and unrelated successes preserve real failures", () => {
  for (const override of [
    {},
    { retryOf: "missing", artifacts: [artifact] },
    { retryOf: "first", artifacts: [] },
    { retryOf: "first", artifacts: [artifact], outputKey: "different" },
    { retryOf: "first", artifacts: [artifact], operationID: "other" },
    { retryOf: "first", artifacts: [artifact], sessionID: "other" },
    { retryOf: "first", artifacts: [{ ...artifact, revision: 0 }] },
  ]) {
    expect(recoveredToolAttempts([item("first", "error"), item("success", "completed", override)]).hidden.size).toBe(0)
  }
  expect(
    recoveredToolAttempts([
      item("first", "error"),
      item("success", "running", { retryOf: "first", artifacts: [artifact] }),
    ]).hidden.size,
  ).toBe(0)
})

test("failed retries and legacy tools remain individually reviewable", () => {
  const grouped = recoveredToolAttempts([
    item("first", "error"),
    item("second", "error", { retryOf: "first" }),
    {
      messageID: "legacy",
      part: { id: "legacy", type: "tool", tool: "bitsbytes-local_create_artifact", state: { status: "completed" } },
    },
  ])
  expect(grouped.hidden.size).toBe(0)
  expect(toolPresentationKey("bitsbytes-local_create_artifact")).toBe("ui.tool.artifact.create")
  expect(toolPresentationKey("bitsbytes-local_generate_image")).toBe("ui.tool.image.generate")
  expect(toolPresentationKey("untrusted_create_artifact")).toBeUndefined()
})
