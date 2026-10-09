import { describe, expect, test } from "bun:test"
import type { Tab } from "./tabs"
import type { ServerConnection } from "./server"
import { sessionHref } from "@/utils/session-route"
import { removeConversationTabs } from "./tab-removal"

const first = "http://first.invalid" as ServerConnection.Key
const second = "http://second.invalid" as ServerConnection.Key
const chat = (sessionId: string, server = first): Tab => ({ type: "session", sessionId, server })

describe("conversation removal navigation", () => {
  test("current targeted routes select the nearest remaining conversation in the same server", () => {
    const tabs = [chat("older"), chat("deleted"), chat("other", second), chat("next")]
    const result = removeConversationTabs({
      tabs,
      server: first,
      sessionIDs: ["deleted"],
      pathname: sessionHref(first, "deleted"),
      activeServer: first,
    })
    expect(result.tabs).toEqual([tabs[0], tabs[2], tabs[3]])
    expect(result.next).toBe(tabs[3])
  })
  test("a delayed old-server deletion preserves the currently selected same-ID chat", () => {
    const tabs = [chat("same"), chat("same", second)]
    const result = removeConversationTabs({
      tabs,
      server: first,
      sessionIDs: ["same"],
      pathname: sessionHref(second, "same"),
      activeServer: second,
    })
    expect(result.tabs).toEqual([tabs[1]])
    expect(result.next).toBeUndefined()
  })
  test("final conversation removal resumes the unsent draft instead of another server", () => {
    const draft: Tab = { type: "draft", draftID: "retained", server: first, directory: "/workspace" }
    const result = removeConversationTabs({
      tabs: [draft, chat("deleted"), chat("other", second)],
      server: first,
      sessionIDs: ["deleted"],
      pathname: sessionHref(first, "deleted"),
      activeServer: first,
    })
    expect(result.next).toBe(draft)
    expect(result.tabs).toContain(draft)
  })
  test("an empty collection returns Home after removing all owned tabs", () => {
    const result = removeConversationTabs({
      tabs: [chat("root"), chat("owned")],
      server: first,
      sessionIDs: ["root", "owned"],
      pathname: sessionHref(first, "root"),
      activeServer: first,
    })
    expect(result.tabs).toEqual([])
    expect(result.next).toBeNull()
  })
  test("legacy routes remain supported without treating Home as an active conversation", () => {
    const tabs = [chat("older"), chat("deleted")]
    expect(
      removeConversationTabs({
        tabs,
        server: first,
        sessionIDs: ["deleted"],
        pathname: "/encoded-folder/session/deleted",
        activeServer: first,
      }).next,
    ).toBe(tabs[0])
    expect(
      removeConversationTabs({ tabs, server: first, sessionIDs: ["deleted"], pathname: "/", activeServer: first }).next,
    ).toBeUndefined()
  })
})
