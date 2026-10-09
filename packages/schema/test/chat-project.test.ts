import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ChatProject } from "../src/chat-project"
import { SessionID } from "../src/session-id"

test("chat unread remains optional for old servers and omits undefined in updates and events", () => {
  const encode = Schema.encodeSync(ChatProject.ChatUpdate)
  expect(encode({ unread: undefined, title: "Saved" })).toEqual({ title: "Saved" })
  expect(encode({ unread: false })).toEqual({ unread: false })
  expect(
    Schema.decodeUnknownSync(ChatProject.Chat)({
      id: "ses_read",
      title: "Old chat",
      directory: "C:/work",
      pinned: false,
      order: 0,
      created: 1,
      updated: 1,
    }).unread,
  ).toBeUndefined()
  expect(
    Schema.encodeSync(ChatProject.ChatChanged.data)({
      sessionID: SessionID.make("ses_read"),
      timestamp: 1,
      unread: true,
    }),
  ).toEqual({
    sessionID: "ses_read",
    timestamp: 1,
    unread: true,
  })
})
