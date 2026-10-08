import { expect, test } from "bun:test"
import { displayedToolStatus, ownsAssistant, ownsPart } from "./execution-activity"

const message = { id: "assistant-old", parentID: "input-old", role: "assistant", time: { created: 1 } }
const status = { type: "busy", owner: { runEpoch: "live-epoch", inputID: "input-old", assistantID: "assistant-old" } }

test("only the exact authoritative assistant owns streaming and tool activity", () => {
  expect(ownsAssistant(status, message)).toBe(true)
  expect(ownsAssistant({ ...status, type: "retry" }, message)).toBe(true)
  expect(ownsAssistant(status, { ...message, id: "assistant-new" })).toBe(false)
  expect(ownsAssistant(status, { ...message, parentID: "input-new" })).toBe(false)
  expect(ownsAssistant({ type: "busy" }, message)).toBe(false)
  expect(ownsAssistant({ type: "idle", owner: status.owner }, message)).toBe(false)
  expect(ownsAssistant({ type: "busy", owner: { ...status.owner, runEpoch: "" } }, message)).toBe(false)
})

test("closed, errored and interrupted history remains static during a later turn", () => {
  expect(ownsAssistant(status, { ...message, time: { created: 1, completed: 2 } })).toBe(false)
  expect(ownsAssistant(status, { ...message, error: { name: "MessageAbortedError" } })).toBe(false)
  expect(ownsAssistant({ ...status, owner: { ...status.owner, assistantID: "new" } }, message)).toBe(false)
  expect(ownsPart(status, { messageID: message.id, time: { end: 2 } })).toBe(false)
  expect(ownsPart(status, { messageID: message.id })).toBe(true)
  expect(displayedToolStatus("running", false)).toBe("interrupted")
  expect(displayedToolStatus("pending", false)).toBe("interrupted")
  expect(displayedToolStatus("running", true)).toBe("running")
  expect(displayedToolStatus("error", false)).toBe("error")
})
