import type { Tab } from "./tabs"
import type { ServerConnection } from "./server"
import { sessionHref } from "@/utils/session-route"

/** Select the replacement from the actual route, rather than the last remembered tab. */
export function removeConversationTabs(input: {
  tabs: readonly Tab[]
  server: ServerConnection.Key
  sessionIDs: readonly string[]
  pathname: string
  activeServer: ServerConnection.Key
}) {
  const ids = new Set(input.sessionIDs)
  const selected = input.tabs.findIndex(
    (tab) =>
      tab.type === "session" &&
      tab.server === input.server &&
      (input.pathname === sessionHref(tab.server, tab.sessionId) ||
        (!input.pathname.startsWith("/server/") &&
          input.activeServer === tab.server &&
          input.pathname.endsWith(`/session/${tab.sessionId}`))),
  )
  const current = input.tabs[selected]
  const removedCurrent = current?.type === "session" && ids.has(current.sessionId)
  const retained = input.tabs.filter(
    (tab) => tab.type !== "session" || tab.server !== input.server || !ids.has(tab.sessionId),
  )
  if (!removedCurrent) return { tabs: retained, next: undefined }
  const kept = new Set(retained)
  const after = input.tabs.slice(selected + 1).filter((tab) => kept.has(tab) && tab.server === input.server)
  const before = input.tabs.slice(0, selected).filter((tab) => kept.has(tab) && tab.server === input.server)
  return { tabs: retained, next: after[0] ?? before.at(-1) ?? null }
}
