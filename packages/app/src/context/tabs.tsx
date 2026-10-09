import type { Session } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createStore, produce } from "solid-js/store"
import { Persist, persisted, removePersisted, draftPersistedKeys } from "@/utils/persist"
import { ServerConnection, useServer } from "./server"
import { createEffect, getOwner, onCleanup, startTransition } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { usePlatform } from "./platform"
import { uuid } from "@/utils/uuid"
import { SessionTabsRemovedDetail } from "@/components/titlebar-session-events"
import { sessionHref } from "@/utils/session-route"
import { createTabMemory } from "./tab-memory"
import { nextTabAfterClose, pushClosedTab, removeClosedTabs, takeClosedTab, type ClosedTab } from "./closed-tabs"
import { createDraftPromptSession, type PromptModel } from "./prompt-state"
import { migrateTabs } from "./tab-migration"
import { removeConversationTabs } from "./tab-removal"

export type SessionTab = {
  type: "session"
  server: ServerConnection.Key
  sessionId: string
  pendingProjectID?: string
}

export type DraftTab = {
  type: "draft"
  draftID: string
  server: ServerConnection.Key
  directory: string
  worktree?: string
  projectID?: string
}

export type Tab = SessionTab | DraftTab

export type TabInfo = {
  title?: string
  directory?: string
}

type RecentTab = {
  key?: string
}

export const draftHref = (draftID: string) => `/new-session?draftId=${encodeURIComponent(draftID)}`

export const tabHref = (tab: Tab) =>
  tab.type === "draft" ? draftHref(tab.draftID) : sessionHref(tab.server, tab.sessionId)

export const tabKey = (tab: Tab) => (tab.type === "draft" ? `draft:${tab.draftID}` : `${tab.server}\n${tabHref(tab)}`)

export function sessionHasOpenTab(tabs: Tab[], server: ServerConnection.Key, session: Session) {
  return tabs.some((tab) => tab.type === "session" && tab.server === server && tab.sessionId === session.id)
}

export const { use: useTabs, provider: TabsProvider } = createSimpleContext({
  name: "Tabs",
  gate: false,
  init: () => {
    const server = useServer()
    const platform = usePlatform()
    const fallback = server.key
    const [store, setStore, _, ready] = persisted(
      {
        ...Persist.window("tabs"),
        migrate: (value: unknown) => migrateTabs(value, fallback),
      },
      createStore<Tab[]>([]),
    )
    const [recent, setRecent, , recentReady] = persisted(Persist.window("tabs.recent"), createStore<RecentTab>({}))
    const [info, setInfo] = persisted(Persist.window("tabs.info"), createStore<Record<string, TabInfo>>({}))
    const [closed, setClosed, , closedReady] = persisted(Persist.window("tabs.closed"), createStore<ClosedTab[]>([]))

    const navigate = useNavigate()
    const location = useLocation()
    const memory = createTabMemory(getOwner())

    const closing = new Set<string>()
    const openingDrafts = new Map<string, Promise<DraftTab>>()
    let recentWrite = 0
    let recentValue: string | undefined

    const recentKey = () => (recentWrite ? recentValue : recent.key)

    const setRecentKey = (key: string | undefined) => {
      const write = ++recentWrite
      recentValue = key
      if (recentReady()) {
        setRecent("key", key)
        return
      }
      void recentReady.promise?.then(() => {
        if (write === recentWrite) setRecent("key", key)
      })
    }

    const updateClosed = (update: (stack: ClosedTab[]) => ClosedTab[]) => {
      const apply = () => setClosed((stack) => update(stack))
      if (closedReady()) {
        apply()
        return
      }
      void closedReady.promise?.then(apply)
    }

    const removeDraftPersisted = (draftID: string) => {
      for (const key of draftPersistedKeys()) {
        const target = Persist.draft(draftID, key)
        removePersisted(key === "prompt" ? Persist.prompt(target) : target, platform)
      }
    }

    const removeInfo = (key: string) => {
      if (!info[key]) return
      setInfo(
        produce((draft) => {
          delete draft[key]
        }),
      )
    }

    onCleanup(memory.dispose)

    createEffect(() => {
      if (!ready() || !recentReady()) return
      const servers = new Set(server.list.map(ServerConnection.key))
      const next = store.filter((tab) => servers.has(tab.server))
      if (next.length !== store.length) {
        for (const tab of store) {
          if (!servers.has(tab.server)) {
            const key = tabKey(tab)
            memory.remove(key)
            removeInfo(key)
          }
        }
        setStore(() => next)
      }
      if (recent.key && !next.some((tab) => tabKey(tab) === recent.key)) setRecentKey(undefined)
      const keys = new Set(next.map(tabKey))
      for (const key of Object.keys(info)) {
        if (!keys.has(key)) removeInfo(key)
      }
    })

    createEffect(() => {
      if (!closedReady()) return
      const servers = new Set(server.list.map(ServerConnection.key))
      const next = closed.filter((entry) => servers.has(entry.tab.server))
      if (next.length !== closed.length) setClosed(() => next)
    })

    const navigateTab = (tab: Tab) => {
      const href = tabHref(tab)
      setRecentKey(tabKey(tab))
      navigate(href)
    }

    const removeTab = (index: number) => {
      const tab = store[index]
      if (!tab) return
      const key = tabKey(tab)
      const draftID = tab.type === "draft" ? tab.draftID : undefined
      const nextTab = nextTabAfterClose(store, index, recentKey() === key && location.pathname !== "/")
      closing.add(key)
      void startTransition(() => {
        setStore(
          produce((tabs) => {
            tabs.splice(index, 1)
          }),
        )
        if (nextTab === null) {
          setRecentKey(undefined)
          navigate("/")
        }
        if (nextTab) navigateTab(nextTab)
      }).finally(() => closing.delete(key))
      memory.remove(key)
      removeInfo(key)
      if (draftID) removeDraftPersisted(draftID)
    }

    const actions = {
      addSessionTab: (tab: Omit<SessionTab, "type">) => {
        const next = { type: "session" as const, ...tab }
        const existing = store.find((item) => tabKey(item) === tabKey(next))
        if (existing) return existing
        void startTransition(() => {
          setStore(
            produce((tabs) => {
              if (tabs.some((item) => tabKey(item) === tabKey(next))) return
              tabs.push(next)
            }),
          )
        })
        return next
      },
      reorder(keys: string[]) {
        setStore(
          produce((tabs) => {
            const byKey = new Map(tabs.map((tab) => [tabKey(tab), tab]))
            const next = keys.map((key) => byKey.get(key)).filter((tab): tab is Tab => !!tab)
            if (next.length !== tabs.length) return
            tabs.splice(0, tabs.length, ...next)
          }),
        )
      },
      draft(draftID: string) {
        const tab = store.find((item) => item.type === "draft" && item.draftID === draftID)
        if (!tab || tab.type !== "draft") throw new Error(`Draft not found: ${draftID}`)
        return tab
      },
      async newDraft(draft: Omit<DraftTab, "type" | "draftID">, prompt?: string, model?: PromptModel) {
        const draftID = uuid()
        const tab = { type: "draft" as const, draftID, ...draft }
        memory.ensure(tabKey(tab), "prompt", () => createDraftPromptSession(draftID, { prompt, model }))
        await startTransition(() => {
          setStore(
            produce((tabs) => {
              tabs.push(tab)
            }),
          )
          navigate(draftHref(draftID))
        })
        return tab
      },
      openDraft(draft: Omit<DraftTab, "type" | "draftID">, model?: PromptModel) {
        const key = JSON.stringify([draft.server, draft.projectID ?? null])
        const pending = openingDrafts.get(key)
        if (pending) return pending
        const operation = (async () => {
          if (!ready()) await ready.promise
          const existing = [...store]
            .reverse()
            .find((tab) => tab.type === "draft" && tab.server === draft.server && tab.projectID === draft.projectID)
          if (existing?.type === "draft") {
            navigateTab(existing)
            return existing
          }
          return actions.newDraft(draft, "", model)
        })().finally(() => openingDrafts.delete(key))
        openingDrafts.set(key, operation)
        return operation
      },
      homeTab(server?: ServerConnection.Key) {
        const available = store.filter((tab) => !server || tab.server === server)
        return available.find((tab) => tabKey(tab) === recentKey()) ?? available.at(-1)
      },
      updateDraft(draftID: string, draft: Partial<Omit<DraftTab, "type" | "draftID">>) {
        void startTransition(() => {
          setStore(
            (tab) => tab.type === "draft" && tab.draftID === draftID,
            produce((tab) => Object.assign(tab, draft)),
          )
        })
      },
      promoteDraft(draftID: string, session: Omit<SessionTab, "type">) {
        // Keep the replacement and navigation atomic so /new-session never renders
        // after its backing draft tab has been removed from the store.
        const active = location.pathname === "/new-session" && location.query.draftId === draftID
        const draft = store.find((tab) => tab.type === "draft" && tab.draftID === draftID)
        const next = {
          type: "session" as const,
          ...session,
          pendingProjectID: draft?.type === "draft" ? draft.projectID : undefined,
        }
        void startTransition(() => {
          setStore(
            produce((tabs) => {
              const index = tabs.findIndex((tab) => tab.type === "draft" && tab.draftID === draftID)
              if (index !== -1) tabs[index] = next
            }),
          )
          if (recent.key === `draft:${draftID}`) setRecentKey(tabKey(next))
          if (active) navigateTab(next)
        })
        memory.remove(`draft:${draftID}`)
        removeDraftPersisted(draftID)
      },
      projectAssigned(sessionId: string, targetServer = server.key) {
        setStore(
          (tab) => tab.type === "session" && tab.server === targetServer && tab.sessionId === sessionId,
          produce((tab) => {
            if (tab.type === "session") delete tab.pendingProjectID
          }),
        )
      },
      removeTab,
      // User-initiated close: records the tab so it can be reopened.
      // Cleanup paths (missing sessions, archive, server removal) go through
      // removeTab and friends directly and are not recorded.
      closeTab(index: number) {
        const tab = store[index]
        if (!tab) return
        if (tab.type === "session") updateClosed((stack) => pushClosedTab(stack, tab, index))
        removeTab(index)
      },
      reopenClosedTab() {
        if (!closedReady()) {
          void closedReady.promise?.then(() => actions.reopenClosedTab())
          return
        }
        const result = takeClosedTab(closed, store)
        if (result.stack.length === closed.length) return
        setClosed(() => result.stack)
        const entry = result.entry
        if (!entry) return
        const index = Math.min(entry.index, store.length)
        void startTransition(() => {
          setStore(
            produce((tabs) => {
              if (tabs.some((item) => tabKey(item) === tabKey(entry.tab))) return
              tabs.splice(index, 0, entry.tab)
            }),
          )
          navigateTab(entry.tab)
        })
      },
      removeSessionTab(input: Omit<SessionTab, "type">) {
        updateClosed((stack) => removeClosedTabs(stack, input.server, [input.sessionId]))
        const index = store.findIndex(
          (tab) => tab.type === "session" && tab.server === input.server && tab.sessionId === input.sessionId,
        )
        if (index !== -1) removeTab(index)
      },
      removeServer(key: ServerConnection.Key) {
        updateClosed((stack) => stack.filter((entry) => entry.tab.server !== key))
        const drafts = store.flatMap((tab) => (tab.type === "draft" && tab.server === key ? [tab.draftID] : []))
        const removed = store.filter((tab) => tab.server === key).map(tabKey)
        setStore((tabs) => tabs.filter((tab) => tab.server !== key))
        for (const key of removed) memory.remove(key)
        for (const key of removed) removeInfo(key)
        if (recent.key && removed.includes(recent.key)) setRecentKey(undefined)
        for (const draftID of drafts) removeDraftPersisted(draftID)
        if (server.key === key) navigate("/")
      },
      removeSessions: (input: SessionTabsRemovedDetail) => {
        const targetServer = input.server ?? server.key
        updateClosed((stack) => removeClosedTabs(stack, targetServer, input.sessionIDs))
        const removed = store
          .filter(
            (tab) => tab.type === "session" && tab.server === targetServer && input.sessionIDs.includes(tab.sessionId),
          )
          .map(tabKey)
        void startTransition(() => {
          setStore(
            produce((tabs) => {
              const result = removeConversationTabs({
                tabs,
                server: targetServer,
                sessionIDs: input.sessionIDs,
                pathname: location.pathname,
                activeServer: server.key,
              })
              tabs.splice(0, tabs.length, ...result.tabs)
              if (result.next) navigateTab(result.next)
              else if (result.next === null) {
                setRecentKey(undefined)
                navigate("/")
              }
            }),
          )
          if (recent.key && removed.includes(recent.key)) setRecentKey(undefined)
        })
        for (const key of removed) memory.remove(key)
        for (const key of removed) removeInfo(key)
      },
      rememberSessionInfo(tab: SessionTab, session: Session) {
        const key = tabKey(tab)
        const next = { title: session.title, directory: session.directory }
        const current = info[key]
        if (current?.title === next.title && current.directory === next.directory) return
        setInfo(key, next)
      },
      select: navigateTab,
      remember(tab: Tab) {
        const key = tabKey(tab)
        if (recentKey() !== key) setRecentKey(key)
      },
      toggleHome(input: { home: boolean; current?: Tab }) {
        if (input.home) {
          const tab = store.find((tab) => tabKey(tab) === recentKey())
          if (tab) navigateTab(tab)
          return
        }
        if (input.current) {
          setRecentKey(tabKey(input.current))
          navigate("/")
          return
        }
        navigate("/")
      },
      state<T>(tab: Tab, name: string, init: () => T) {
        return memory.ensure(tabKey(tab), name, init)
      },
      stateValue<T>(tab: Tab, name: string) {
        return memory.get<T>(tabKey(tab), name)
      },
    }

    return { ...actions, store, info, ready, recentReady }
  },
})
