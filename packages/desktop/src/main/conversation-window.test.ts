import { describe, expect, test } from "bun:test"
import { createConversationWindowTargets, parseConversationWindowTarget } from "./conversation-window"
import { conversationWindowURL } from "../renderer/conversation-window"

describe("conversation window targets", () => {
  const input = { server: "sidecar", sessionID: "ses_history", directory: "D:\\Chats\\é" }
  test("accepts known server identities and absolute local or remote folders", () => {
    expect(parseConversationWindowTarget(input)).toEqual(input)
    expect(
      parseConversationWindowTarget({ ...input, server: "wsl:Ubuntu", directory: "/home/test/project" })?.server,
    ).toBe("wsl:Ubuntu")
    expect(parseConversationWindowTarget({ ...input, server: "https://chat.example/api" })?.server).toBe(
      "https://chat.example/api",
    )
    expect(parseConversationWindowTarget({ ...input, directory: "\\\\server\\share\\folder" })?.directory).toBe(
      "\\\\server\\share\\folder",
    )
  })
  test("rejects credential payloads, navigation injection and malformed identities", () => {
    for (const value of [
      null,
      [],
      { ...input, server: "https://user:secret@chat.example" },
      { ...input, server: "https://chat.example?password=secret" },
      { ...input, server: "javascript:alert(1)" },
      { ...input, sessionID: "ses_history/../new-session" },
      { ...input, directory: "relative" },
      { ...input, directory: "D:\\Chats\nfile" },
    ]) {
      expect(parseConversationWindowTarget(value)).toBeUndefined()
    }
  })
  test("isolates initial targets and consumes each seed once", () => {
    const targets = createConversationWindowTargets<object>()
    const original = {},
      child = {}
    const target = parseConversationWindowTarget(input)!
    targets.seed(child, target)
    target.directory = "D:\\Changed"
    expect(targets.consume(original)).toBeNull()
    expect(targets.consume(child)).toEqual(input)
    expect(targets.consume(child)).toBeNull()
  })
  test("chooses the target route before restoring ordinary window navigation", () => {
    const target = parseConversationWindowTarget(input)!
    expect(conversationWindowURL(target, "/new-session?draftId=old")).toBe("/server/c2lkZWNhcg/session/ses_history")
    expect(conversationWindowURL(undefined, "/new-session?draftId=old")).toBe("/new-session?draftId=old")
  })
})
