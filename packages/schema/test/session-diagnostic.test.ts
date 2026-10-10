import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Session } from "../src/session"

test("diagnostic ownership validates its immutable key and session identities", () => {
  const value = {
    key: "a".repeat(32),
    parentID: Session.ID.make("ses_parent"),
    ownerID: Session.ID.make("ses_owner"),
  }
  expect(Schema.decodeUnknownSync(Session.Diagnostic)(value)).toEqual(value)
  expect(Schema.encodeSync(Session.Diagnostic)(value)).toEqual(value)
  expect(() => Schema.decodeUnknownSync(Session.Diagnostic)({ ...value, key: "invalid" })).toThrow()
  expect(() => Schema.decodeUnknownSync(Session.Diagnostic)({ ...value, parentID: "foreign" })).toThrow()
})

test("old session metadata retains an omitted diagnostic field", () => {
  const session = Schema.decodeUnknownSync(Session.Info)({
    id: "ses_main",
    projectID: "global",
    title: "Main chat",
    location: { directory: "C:/work" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  })
  expect(session.diagnostic).toBeUndefined()
  expect(Schema.encodeSync(Session.Info)(session)).not.toHaveProperty("diagnostic")
})
