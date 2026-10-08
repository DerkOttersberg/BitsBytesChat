import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionStatusEvent } from "../src/session-status-event"
import { ToolOperation } from "../src/tool-operation"

test("optional execution ownership omits undefined and decodes legacy statuses", () => {
  const encode = Schema.encodeSync(SessionStatusEvent.Info)
  expect(encode({ type: "busy", owner: undefined })).toEqual({ type: "busy" })
  expect(Schema.decodeUnknownSync(SessionStatusEvent.Info)({ type: "busy" })).toEqual({ type: "busy" })
  expect(encode({ type: "busy", owner: { runEpoch: "epoch", inputID: "input", assistantID: undefined } })).toEqual({
    type: "busy",
    owner: { runEpoch: "epoch", inputID: "input" },
  })
})

test("operation metadata recovery rejects malformed lineage and strips private fields", () => {
  const info = {
    operationID: "op",
    attemptID: "attempt",
    sessionID: "chat",
    tool: "create_artifact",
    outputKey: "output",
  }
  expect(ToolOperation.read({ ...info, apiKey: "private", arguments: { code: "private" } })).toEqual(info)
  for (const value of [
    null,
    {},
    { ...info, attemptID: "bad\nID" },
    { ...info, retryOf: 1 },
    { ...info, artifacts: [{ id: "file", revision: 0, hash: "hash" }] },
  ])
    expect(ToolOperation.read(value)).toBeUndefined()
})
