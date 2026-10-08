import { expect, test } from "bun:test"
import { inputFingerprint } from "../../src/session/input-fingerprint"

test("exact retries compare canonical content, excluding delivery controls", () => {
  const input = {
    sessionID: "ses_a",
    messageID: "msg_a",
    noReply: true,
    parts: [{ text: "Frozen 🌿", type: "text" }],
    model: { modelID: "luna", providerID: "test" },
  }
  expect(inputFingerprint(input)).toBe(
    inputFingerprint({
      model: { providerID: "test", modelID: "luna" },
      parts: [{ type: "text", text: "Frozen 🌿" }],
      resume: true,
      revision: 1,
    }),
  )
  expect(inputFingerprint(input)).toBe(inputFingerprint({ ...input, variant: undefined }))
})

test("text, frozen attachment revisions, model, agent and ordered parts distinguish conflicting retries", () => {
  const input = {
    agent: "build",
    model: { modelID: "luna", providerID: "test" },
    parts: [
      { type: "text", text: "Hello" },
      { type: "file", url: "bitsbytes://transcript/frozen?revision=3" },
    ],
  }
  const original = inputFingerprint(input)
  for (const changed of [
    { ...input, agent: "plan" },
    { ...input, model: { ...input.model, modelID: "other" } },
    { ...input, parts: [...input.parts].reverse() },
    { ...input, parts: [input.parts[0], { type: "file", url: "bitsbytes://transcript/frozen?revision=4" }] },
    { ...input, parts: [{ type: "text", text: "Changed" }, input.parts[1]] },
  ])
    expect(inputFingerprint(changed)).not.toBe(original)
})
