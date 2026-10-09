import { For, Show, createEffect, createMemo, onCleanup, onMount, untrack, type ParentProps } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLocation, useNavigate } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import type { ChatProject } from "@opencode-ai/schema/chat-project"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { usePlatform } from "@/context/platform"
import { useGlobal } from "@/context/global"
import { ServerConnection, useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { useSettingsCommand } from "@/components/settings-dialog"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useNotification } from "@/context/notification"
import { Portal } from "solid-js/web"
import type { createConversationActions } from "@/utils/conversation-actions"
import { Persist, persisted } from "@/utils/persist"
import { createOrganizationClient } from "@/utils/organization-api"
import "./organization-shell.css"

type View = "chat" | "artifacts" | "skills" | "recordings"
type Artifact = { id: string; sessionID: string; filename: string; kind?: string; updated: number; revision: number }

export function OrganizationShell(props: ParentProps) {
  const platform = usePlatform(),
    language = useLanguage(),
    global = useGlobal(),
    server = useServer(),
    tabs = useTabs()
  const location = useLocation(),
    navigate = useNavigate(),
    command = useCommand(),
    settings = useSettingsCommand(),
    pickDirectory = useDirectoryPicker(),
    notification = useNotification()
  const [saved, setSaved] = persisted(
    Persist.window("organization.sidebar.v1"),
    createStore({ width: 332, collapsed: false, expanded: {} as Record<string, boolean> }),
  )
  const [state, setState] = createStore({
    view: "chat" as View,
    drawer: false,
    projects: [] as ChatProject.Info[],
    chats: [] as ChatProject.Chat[],
    pinned: [] as ChatProject.Chat[],
    pinnedNext: "",
    children: {} as Record<string, ChatProject.Page>,
    next: "",
    search: "",
    archived: false,
    sort: "updated" as "updated" | "created",
    loading: false,
    error: "",
    dialog: undefined as
      | undefined
      | {
          kind: "project" | "rename" | "delete"
          id?: string
          value: string
          directory: string
          folder?: boolean
          draftID?: string
          moveID?: string
        },
    artifacts: [] as Artifact[],
    account: "",
    defaultDirectory: "",
    searchOpen: false,
    visitEpoch: 0,
    childLoading: {} as Record<string, boolean>,
    drag: undefined as undefined | { id: string; title: string; x: number; y: number; target?: string },
  })
  const currentServer = createMemo(() => server.current ?? global.servers.list()[0])
  const client = createMemo(() =>
    currentServer() ? createOrganizationClient(currentServer()!.http, platform.fetch) : undefined,
  )
  const context = createMemo(() => (currentServer() ? global.ensureServerCtx(currentServer()!) : undefined))
  const activeID = createMemo(() => location.pathname.match(/\/session\/([^/]+)$/)?.[1])
  let generation = 0,
    queryGeneration = 0,
    pinnedGeneration = 0,
    disposed = false,
    refreshTimer: ReturnType<typeof setTimeout> | undefined
  const childQueries = new Map<string, number>()
  let searchInput: HTMLInputElement | undefined
  let scrollElement: HTMLDivElement | undefined
  let homeOpening = false
  let lastViewed: string | undefined
  const actionServices = new Map<string, Promise<ReturnType<typeof createConversationActions>>>()
  let pendingArtifact: Artifact | undefined
  let artifactTimeout: ReturnType<typeof setTimeout> | undefined
  let openingArtifact = false
  const mergePage = (
    page: ChatProject.Page,
    previous: ChatProject.Page | undefined,
    more: boolean,
    sort = state.sort,
  ) => {
    if (!previous?.data.length) return page
    const ids = new Set(page.data.map((chat) => chat.id))
    const last = page.data.at(-1)
    const tail = more
      ? previous.data
      : previous.data.filter(
          (chat) =>
            !ids.has(chat.id) &&
            last &&
            (sort === "created" ? chat.created <= last.created : chat.updated <= last.updated),
        )
    return {
      data: [
        ...new Map((more ? [...tail, ...page.data] : [...page.data, ...tail]).map((chat) => [chat.id, chat])).values(),
      ],
      next: !more && tail.length ? previous.next : page.next,
    }
  }
  const tryPendingArtifact = () => {
    if (openingArtifact || !pendingArtifact || activeID() !== pendingArtifact.sessionID) return
    const detail = { ...pendingArtifact, handled: false }
    openingArtifact = true
    window.dispatchEvent(new CustomEvent("bitsbytes:open-artifact", { detail }))
    openingArtifact = false
    if (!detail.handled) return
    pendingArtifact = undefined
    if (artifactTimeout) clearTimeout(artifactTimeout)
  }
  const pending = new Set<string>()
  const pendingKey = (id: string, conn = currentServer()!) => `${ServerConnection.key(conn)}\n${id}`
  const chatWrites = new Map<string, Promise<ChatProject.Chat>>()
  const saveChat = (id: string, value: ChatProject.ChatUpdate) => {
    const api = client()!,
      key = `${ServerConnection.key(currentServer()!)}\n${id}`
    const previous = chatWrites.get(key)
    const operation = (previous ?? Promise.resolve()).catch(() => undefined).then(() => api.chat(id, value))
    chatWrites.set(key, operation)
    const clear = () => {
      if (chatWrites.get(key) === operation) chatWrites.delete(key)
    }
    void operation.then(clear, clear)
    return operation
  }
  const cachedChat = (id: string) =>
    state.chats.find((chat) => chat.id === id) ??
    state.pinned.find((chat) => chat.id === id) ??
    Object.values(state.children)
      .flatMap((page) => page.data)
      .find((chat) => chat.id === id)
  const patchCachedChat = (id: string, change?: Partial<ChatProject.Chat>) => {
    const previous = cachedChat(id)
    const changedSearchTitle =
      state.search && previous && change?.title !== undefined && previous.title !== change.title
    const next = change && previous ? { ...previous, ...change } : undefined
    setState(
      "chats",
      reconcile(
        state.chats.flatMap((chat) =>
          chat.id !== id ? [chat] : next && Boolean(next.archived) === state.archived ? [next] : [],
        ),
        { key: "id" },
      ),
    )
    setState(
      "pinned",
      reconcile(
        [...state.pinned.filter((chat) => chat.id !== id), ...(next?.pinned && !next.archived ? [next] : [])].sort(
          (a, b) => b.updated - a.updated || b.id.localeCompare(a.id),
        ),
        { key: "id" },
      ),
    )
    for (const projectID of Object.keys(state.children)) {
      const page = state.children[projectID]
      const found = page.data.some((chat) => chat.id === id)
      const data = page.data.flatMap((chat) =>
        chat.id !== id ? [chat] : next && !next.archived && next.projectID === projectID ? [next] : [],
      )
      if (!found && next && !next.archived && next.projectID === projectID) data.unshift(next)
      data.sort(
        (a, b) =>
          (state.sort === "created" ? b.created - a.created : b.updated - a.updated) || b.id.localeCompare(a.id),
      )
      setState("children", projectID, reconcile({ ...page, data }, { key: "id" }))
    }
    if (changedSearchTitle) {
      queryGeneration++
      setState({ chats: [], next: "", loading: false })
    }
  }
  const fail = (error: unknown) =>
    setState(
      "error",
      error instanceof Error && error.message.startsWith("organization.")
        ? language.t(error.message as "organization.error.request")
        : language.t("organization.error.request"),
    )
  const closeDrawer = () => setState("drawer", false)
  const setView = (view: View) => {
    setState({ view, drawer: false, error: "" })
    window.dispatchEvent(
      new CustomEvent("bitsbytes:utility-select", {
        detail: { tab: view === "skills" || view === "recordings" ? view : "chats" },
      }),
    )
  }
  const openChat = (chat: Pick<ChatProject.Chat, "id" | "directory">) => {
    const conn = currentServer()
    if (!conn) return
    context()?.projects.open(chat.directory)
    setView("chat")
    tabs.select(tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: chat.id }))
  }
  const newChat = (project?: ChatProject.Info, model?: Parameters<typeof tabs.newDraft>[2]) => {
    const conn = currentServer()
    const directory = project?.directory || state.defaultDirectory || context()?.projects.list()[0]?.worktree
    if (!conn || !directory) return
    context()?.projects.open(directory)
    setView("chat")
    void tabs.openDraft({ server: ServerConnection.key(conn), directory, projectID: project?.id }, model)
  }
  const home = () => {
    setView("chat")
    if (location.pathname !== "/") return
    const conn = currentServer()
    if (!conn || !tabs.ready() || !tabs.recentReady() || !state.defaultDirectory || homeOpening) return
    const tab = tabs.homeTab(ServerConnection.key(conn))
    if (tab) {
      tabs.select(tab)
      return
    }
    homeOpening = true
    const directory = state.defaultDirectory
    context()?.projects.open(directory)
    void tabs.openDraft({ server: ServerConnection.key(conn), directory }).finally(() => {
      homeOpening = false
    })
  }
  const loadChildren = async (id: string, more = false) => {
    const api = client(),
      token = generation
    if (!api) return
    if (more && state.childLoading[id]) return
    const request = (childQueries.get(id) ?? 0) + 1
    childQueries.set(id, request)
    setState("childLoading", id, true)
    const page = await api
      .chats({ projectID: id, sort: state.sort, cursor: more ? state.children[id]?.next : undefined })
      .finally(() => {
        if (childQueries.get(id) === request) setState("childLoading", id, false)
      })
    if (disposed || token !== generation || childQueries.get(id) !== request) return
    setState("children", id, reconcile(mergePage(page, state.children[id], more), { key: "id" }))
  }
  const loadPins = async (more = false) => {
    const api = client(),
      token = generation,
      request = ++pinnedGeneration
    if (!api || (more && state.loading)) return
    const page = await api.chats({ pinned: true, limit: 100, cursor: more ? state.pinnedNext : undefined })
    if (disposed || token !== generation || request !== pinnedGeneration) return
    const retained = mergePage(page, { data: state.pinned, next: state.pinnedNext || undefined }, more, "updated")
    setState("pinned", reconcile([...retained.data], { key: "id" }))
    setState("pinnedNext", retained.next ?? "")
  }
  const refresh = async (more = false) => {
    const api = client(),
      token = generation
    if (!api || (more && state.loading)) return
    const request = ++queryGeneration
    setState("loading", true)
    try {
      const [projects, page] = await Promise.all([
        more ? Promise.resolve(state.projects) : api.projects(),
        api.chats({
          search: state.search,
          archived: state.archived,
          sort: state.sort,
          cursor: more ? state.next : undefined,
        }),
        more ? Promise.resolve() : loadPins(),
      ])
      if (disposed || token !== generation || request !== queryGeneration) return
      // Keep row owners (and their open menus/focus) through background refreshes.
      setState("projects", reconcile([...projects], { key: "id" }))
      if (!more) {
        const projectIDs = new Set(projects.map((project) => project.id))
        for (const tab of tabs.store) {
          if (tab.server !== ServerConnection.key(currentServer()!)) continue
          if (tab.type === "draft" && tab.projectID && !projectIDs.has(tab.projectID))
            tabs.updateDraft(tab.draftID, { projectID: undefined })
          if (tab.type === "session" && tab.pendingProjectID && !projectIDs.has(tab.pendingProjectID))
            tabs.projectAssigned(tab.sessionId, tab.server)
        }
        const cached = new Map(
          [...state.chats, ...state.pinned, ...Object.values(state.children).flatMap((child) => child.data)].map(
            (chat) => [chat.id, chat],
          ),
        )
        for (const chat of cached.values())
          if (chat.projectID && !projectIDs.has(chat.projectID))
            patchCachedChat(chat.id, { projectID: undefined, projectName: undefined })
      }
      const retained = mergePage(page, { data: state.chats, next: state.next || undefined }, more)
      setState("chats", reconcile([...retained.data], { key: "id" }))
      setState({
        next: retained.next ?? "",
        error: "",
      })
      if (!more)
        await Promise.all(
          projects.filter((project) => saved.expanded[project.id] !== false).map((project) => loadChildren(project.id)),
        )
    } catch (error) {
      if (!disposed && token === generation && request === queryGeneration) fail(error)
    } finally {
      if (!disposed && token === generation && request === queryGeneration) setState("loading", false)
    }
  }
  const schedule = () => {
    if (refreshTimer) return
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      void refresh()
    }, 250)
  }
  const mutate = async (action: Promise<unknown>) => {
    const token = generation
    try {
      await action
      if (token === generation) await refresh()
    } catch (error) {
      if (token === generation) fail(error)
    }
  }
  const updateChat = (chat: ChatProject.Chat, value: ChatProject.ChatUpdate) => {
    const conn = currentServer(),
      owner = context(),
      token = generation
    if (!conn || !owner || !client()) return
    const key = ServerConnection.key(conn)
    void mutate(
      saveChat(chat.id, value).then((next) => {
        if (token === generation) patchCachedChat(chat.id, next)
        const cached = owner.sync.session.peek(chat.id)
        if (cached)
          owner.sync.session.remember({
            ...cached,
            title: next.title,
            time: { ...cached.time, archived: next.archived },
          })
        if (value.archived) {
          tabs.removeSessions({ server: key, directory: chat.directory, sessionIDs: [chat.id] })
        }
      }),
    )
  }
  const saveDialog = async (event: SubmitEvent) => {
    event.preventDefault()
    const dialog = state.dialog,
      api = client(),
      owner = context(),
      token = generation
    if (!dialog || !api) return
    try {
      if (dialog.kind === "delete" && dialog.id) {
        const actions = await conversationActions()
        await actions.remove({ id: dialog.id, title: dialog.value, directory: dialog.directory })
      }
      if (dialog.kind === "project") {
        const value = {
          name: dialog.value,
          directory: dialog.directory ? AbsolutePath.make(dialog.directory) : undefined,
        }
        if (dialog.id) await api.update(dialog.id, { ...value, directory: value.directory ?? null })
        else {
          const project = await api.create(value)
          if (token === generation) setSaved("expanded", project.id, true)
          if (dialog.draftID) tabs.updateDraft(dialog.draftID, { projectID: project.id })
          if (dialog.moveID) await api.chat(dialog.moveID, { projectID: project.id })
        }
      }
      if (dialog.kind === "rename" && dialog.id) {
        const updated = await api.chat(dialog.id, { title: dialog.value })
        const cached = owner?.sync.session.peek(dialog.id)
        if (cached) owner?.sync.session.remember({ ...cached, title: updated.title })
      }
      if (token === generation) {
        setState("dialog", undefined)
        await refresh()
      }
    } catch (error) {
      if (token === generation) fail(error)
    }
  }
  const retryAssignments = async () => {
    const conn = currentServer(),
      api = client(),
      token = generation
    if (!conn || !api) return
    for (const tab of tabs.store) {
      if (
        tab.type !== "session" ||
        !tab.pendingProjectID ||
        tab.server !== ServerConnection.key(conn) ||
        pending.has(pendingKey(tab.sessionId, conn))
      )
        continue
      const key = pendingKey(tab.sessionId, conn)
      pending.add(key)
      try {
        await api.chat(tab.sessionId, { projectID: tab.pendingProjectID })
        tabs.projectAssigned(tab.sessionId, ServerConnection.key(conn))
        if (token === generation) schedule()
      } catch (error) {
        if (token === generation) fail(error)
      } finally {
        pending.delete(key)
      }
    }
  }
  createEffect(() => {
    tabs.store.map((tab) => (tab.type === "session" ? tab.pendingProjectID : ""))
    untrack(() => void retryAssignments())
  })
  createEffect(() => {
    const conn = currentServer()
    generation++
    setState({ projects: [], chats: [], children: {}, pinned: [], pinnedNext: "", next: "", dialog: undefined })
    pendingArtifact = undefined
    if (!conn) return
    const token = generation
    const api = client()!
    const init = async () => {
      await server.ready.promise
      const native = await platform.bitsbytes
        ?.call<{ root: string; account?: string | { email?: string } }>("state")
        .catch(() => undefined)
      if (token !== generation || disposed) return
      const directory = native?.root ? native.root + "\\workspace" : (context()?.projects.list()[0]?.worktree ?? "")
      setState({
        defaultDirectory: directory,
        account: typeof native?.account === "string" ? native.account : (native?.account?.email ?? ""),
      })
      await api.migrate({
        projects: (context()?.projects.list() ?? []).map((project) => ({
          directory: AbsolutePath.make(project.worktree),
          name: project.name,
        })),
        defaultDirectory: directory ? AbsolutePath.make(directory) : undefined,
      })
      if (token === generation) await refresh()
    }
    void init().catch((error) => {
      if (token === generation) fail(error)
    })
    const unsubscribe = context()?.sdk.event.listen((event) => {
      if (token !== generation || disposed) return
      const type = event.details.type
      const properties = event.details.properties as Record<string, unknown>
      const info =
        properties?.info && typeof properties.info === "object"
          ? (properties.info as Record<string, unknown>)
          : undefined
      const id =
        typeof properties?.sessionID === "string"
          ? properties.sessionID
          : typeof info?.id === "string"
            ? info.id
            : undefined
      if (type === "session.deleted" && id) patchCachedChat(id)
      if (String(type) === "organization.chat.updated" && id) {
        const change: Partial<ChatProject.Chat> = {
          ...(typeof properties.title === "string" ? { title: properties.title } : {}),
          ...(typeof properties.unread === "boolean" ? { unread: properties.unread } : {}),
          ...(typeof properties.pinned === "boolean" ? { pinned: properties.pinned } : {}),
          ...(properties.projectID !== undefined
            ? {
                projectID: properties.projectID ? String(properties.projectID) : undefined,
                projectName: state.projects.find((project) => project.id === properties.projectID)?.name,
              }
            : {}),
          ...(typeof properties.archived === "boolean"
            ? { archived: properties.archived ? Number(properties.timestamp) : undefined }
            : {}),
        }
        patchCachedChat(id, change)
      }
      if (type === "session.updated" && id && info) {
        const time = info.time && typeof info.time === "object" ? (info.time as Record<string, unknown>) : undefined
        patchCachedChat(id, {
          ...(typeof info.title === "string" ? { title: info.title } : {}),
          ...(typeof time?.updated === "number" ? { updated: time.updated } : {}),
          ...(time ? { archived: typeof time.archived === "number" ? time.archived : undefined } : {}),
        })
      }
      if (type === "server.connected") {
        queryGeneration++
        pinnedGeneration++
        childQueries.forEach((value, key) => childQueries.set(key, value + 1))
        setState({ chats: [], pinned: [], children: {}, next: "", pinnedNext: "", childLoading: {}, loading: false })
        setState("visitEpoch", (epoch) => epoch + 1)
      }
      if (
        type === "session.created" ||
        type === "session.updated" ||
        type === "session.deleted" ||
        type === "message.updated" ||
        String(type).startsWith("session.next.prompt") ||
        String(type).startsWith("session.next.user") ||
        type === "server.connected" ||
        String(type).startsWith("organization.")
      )
        schedule()
    })
    onCleanup(() => unsubscribe?.())
  })
  createEffect(() => {
    state.search
    state.sort
    state.archived
    untrack(() => {
      queryGeneration++
      childQueries.forEach((value, key) => childQueries.set(key, value + 1))
      setState({ chats: [], next: "", children: {}, childLoading: {}, loading: false })
    })
    const timer = setTimeout(() => void refresh(), 160)
    onCleanup(() => clearTimeout(timer))
  })
  createEffect(() => {
    const pathname = location.pathname
    const ready = tabs.ready() && tabs.recentReady() && state.defaultDirectory
    untrack(() => {
      if (pathname === "/" && ready) {
        home()
        return
      }
      if (pathname !== "/") {
        setView("chat")
        closeDrawer()
        queueMicrotask(tryPendingArtifact)
      }
    })
  })
  createEffect(() => {
    const id = state.view === "chat" ? activeID() : undefined
    const conn = currentServer()
    const ready = server.ready()
    const visit = id && conn && ready ? `${ServerConnection.key(conn)}\n${id}\n${state.visitEpoch}` : undefined
    untrack(() => {
      if (lastViewed === visit) return
      lastViewed = visit
      if (!id || !conn || !ready) return
      notification.ensureServerState(ServerConnection.key(conn)).session.markViewed(id)
      void saveChat(id, { unread: false }).catch(fail)
    })
  })
  createEffect(() => {
    if (!state.dialog) return
    const previous = document.activeElement
    const frame = requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(".bb-org-modal input,.bb-org-modal select,.bb-org-modal button")?.focus(),
    )
    onCleanup(() => {
      cancelAnimationFrame(frame)
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    })
  })
  onMount(() => {
    const toggle = () =>
      window.innerWidth < 900 ? setState("drawer", !state.drawer) : setSaved("collapsed", !saved.collapsed)
    const utility = (event: Event) => {
      const tab = (event as CustomEvent).detail?.tab
      if (tab === "skills" || tab === "recordings" || tab === "chats") setState("view", tab === "chats" ? "chat" : tab)
    }
    const createChat = (event: Event) => {
      event.preventDefault()
      newChat(undefined, (event as CustomEvent).detail?.model)
    }
    const createProject = (event: Event) =>
      setState("dialog", { kind: "project", value: "", directory: "", draftID: (event as CustomEvent).detail?.draftID })
    window.dispatchEvent(
      new CustomEvent("bitsbytes:utility-host", { detail: document.getElementById("bitsbytes-utility-content") }),
    )
    window.addEventListener("bitsbytes:sidebar-toggle", toggle)
    window.addEventListener("bitsbytes:utility-state", utility)
    window.addEventListener("bitsbytes:new-chat", createChat)
    window.addEventListener("bitsbytes:new-project", createProject)
    window.addEventListener("bitsbytes:artifact-change", tryPendingArtifact)
    onCleanup(() => {
      disposed = true
      generation++
      if (refreshTimer) clearTimeout(refreshTimer)
      if (artifactTimeout) clearTimeout(artifactTimeout)
      window.removeEventListener("bitsbytes:sidebar-toggle", toggle)
      window.removeEventListener("bitsbytes:utility-state", utility)
      window.removeEventListener("bitsbytes:new-chat", createChat)
      window.removeEventListener("bitsbytes:new-project", createProject)
      window.removeEventListener("bitsbytes:artifact-change", tryPendingArtifact)
    })
  })
  command.register("organization", () => [
    {
      id: "organization.sidebar.toggle",
      title: language.t("organization.toggle"),
      keybind: "mod+b",
      onSelect: () => window.dispatchEvent(new Event("bitsbytes:sidebar-toggle")),
    },
  ])
  const orderedProjects = createMemo(() =>
    [...state.projects].sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order || a.created - b.created,
    ),
  )
  const visibleRecents = createMemo(() => state.chats.filter((chat) => state.search || state.archived || !chat.pinned))
  const conversationActions = async () => {
    const conn = currentServer()!,
      owner = context()!,
      api = client()!,
      key = ServerConnection.key(conn)
    const cached = actionServices.get(key)
    if (cached) return cached
    const service = import("@/utils/conversation-actions").then(({ createConversationActions }) =>
      createConversationActions({
        sdk: owner.sdk,
        platform,
        organization: api,
        labels: { user: language.t("context.breakdown.user"), assistant: language.t("context.breakdown.assistant") },
        onRemoved: (ids) => {
          for (const id of ids) {
            owner.sync.session.evict(id)
          }
        },
      }),
    )
    actionServices.set(key, service)
    return service
  }
  const unread = (chat: ChatProject.Chat) =>
    chat.unread ||
    Boolean(
      currentServer() &&
        notification.ensureServerState(ServerConnection.key(currentServer()!)).session.unseenCount(chat.id),
    )
  const actOnChat = (chat: ChatProject.Chat, method: "fork" | "copyTitle" | "copyConversation") => {
    const token = generation,
      source = { ...chat }
    void conversationActions()
      .then(async (actions) => await actions[method](source))
      .then((next) => {
        if (token === generation && method === "fork" && next)
          openChat({ id: next.id as ChatProject.Chat["id"], directory: AbsolutePath.make(next.directory) })
      })
      .catch((error) => {
        if (token === generation) fail(error)
      })
  }
  const openChatWindow = (chat: ChatProject.Chat) => {
    const token = generation
    void platform.openConversationWindow!({
      server: ServerConnection.key(currentServer()!),
      sessionID: chat.id,
      directory: chat.directory,
    }).catch((error) => {
      if (token === generation) fail(error)
    })
  }
  const markRead = (chat: ChatProject.Chat) => {
    const value = unread(chat)
    if (value) notification.ensureServerState(ServerConnection.key(currentServer()!)).session.markViewed(chat.id)
    updateChat(chat, { unread: !value })
  }
  const moveChat = async (chat: ChatProject.Chat, projectID: string) => {
    const conn = currentServer()!,
      key = pendingKey(chat.id, conn),
      token = generation
    if ((chat.projectID ?? "") === projectID || pending.has(key)) return
    const api = client()
    if (!api) return
    pending.add(key)
    const original = { ...chat }
    const oldProject = chat.projectID
    const next = {
      ...chat,
      projectID: projectID ? (projectID as ChatProject.ID) : undefined,
      projectName: state.projects.find((project) => project.id === projectID)?.name,
    }
    setState("chats", (row) => row.id === chat.id, next)
    setState("pinned", (row) => row.id === chat.id, next)
    if (oldProject && state.children[oldProject])
      setState("children", oldProject, {
        ...state.children[oldProject],
        data: state.children[oldProject].data.filter((row) => row.id !== chat.id),
      })
    if (projectID && state.children[projectID] && !state.children[projectID].data.some((row) => row.id === chat.id))
      setState("children", projectID, { ...state.children[projectID], data: [next, ...state.children[projectID].data] })
    let failure: unknown
    try {
      await saveChat(chat.id, { projectID: projectID ? (projectID as ChatProject.ID) : null })
      tabs.projectAssigned(chat.id, ServerConnection.key(conn))
    } catch (error) {
      failure = error
      if (token === generation)
        patchCachedChat(chat.id, { ...original, projectID: original.projectID, projectName: original.projectName })
    } finally {
      pending.delete(key)
      if (token === generation) await refresh()
    }
    if (failure && token === generation) fail(failure)
  }
  let dragCleanup: (() => void) | undefined
  let suppressClick = false
  const startDrag = (event: PointerEvent, chat: ChatProject.Chat) => {
    if (event.button !== 0 || pending.has(pendingKey(chat.id))) return
    dragCleanup?.()
    const source = event.currentTarget as HTMLElement,
      startX = event.clientX,
      startY = event.clientY
    let dragging = false,
      hoverTarget: string | undefined,
      hoverTimer: ReturnType<typeof setTimeout> | undefined,
      frame = 0
    const targetAt = (x: number, y: number) => {
      const target = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-project-drop]")?.dataset.projectDrop
      if (hoverTarget !== target) {
        hoverTarget = target
        if (hoverTimer) clearTimeout(hoverTimer)
        if (target && saved.expanded[target] === false)
          hoverTimer = setTimeout(() => {
            setSaved("expanded", target, true)
            void loadChildren(target).catch(fail)
          }, 600)
      }
      return target
    }
    const move = (current: PointerEvent) => {
      if (current.pointerId !== event.pointerId) return
      if (!dragging && Math.hypot(current.clientX - startX, current.clientY - startY) < 6) return
      if (!dragging) {
        dragging = true
        source.setPointerCapture(event.pointerId)
        document.documentElement.dataset.bbSidebarDragging = "true"
        setState("drag", { id: chat.id, title: chat.title, x: current.clientX, y: current.clientY })
        frame = requestAnimationFrame(scroll)
      }
      current.preventDefault()
      const target = targetAt(current.clientX, current.clientY)
      setState("drag", { id: chat.id, title: chat.title, x: current.clientX, y: current.clientY, target })
    }
    const scroll = () => {
      if (!state.drag || !scrollElement) return
      const bounds = scrollElement.getBoundingClientRect(),
        y = state.drag.y
      const speed =
        y < bounds.top + 36
          ? -Math.min(14, (bounds.top + 36 - y) / 3)
          : y > bounds.bottom - 36
            ? Math.min(14, (y - bounds.bottom + 36) / 3)
            : 0
      if (speed) scrollElement.scrollTop += speed
      const target = targetAt(state.drag.x, state.drag.y)
      if (state.drag.target !== target) setState("drag", "target", target)
      frame = requestAnimationFrame(scroll)
    }
    const cleanup = () => {
      if (hoverTimer) clearTimeout(hoverTimer)
      cancelAnimationFrame(frame)
      if (source.hasPointerCapture(event.pointerId)) source.releasePointerCapture(event.pointerId)
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", finish)
      window.removeEventListener("pointercancel", cleanup)
      window.removeEventListener("blur", cleanup)
      window.removeEventListener("keydown", key, true)
      delete document.documentElement.dataset.bbSidebarDragging
      setState("drag", undefined)
      dragCleanup = undefined
      if (dragging) {
        suppressClick = true
        setTimeout(() => {
          suppressClick = false
        }, 0)
      }
    }
    const finish = (current: PointerEvent) => {
      if (current.pointerId !== event.pointerId) return
      const target = dragging ? targetAt(current.clientX, current.clientY) : undefined
      cleanup()
      if (dragging && target !== undefined) void moveChat(chat, target)
    }
    const key = (current: KeyboardEvent) => {
      if (current.key !== "Escape") return
      current.preventDefault()
      current.stopImmediatePropagation()
      cleanup()
    }
    window.addEventListener("pointermove", move, { passive: false })
    window.addEventListener("pointerup", finish)
    window.addEventListener("pointercancel", cleanup)
    window.addEventListener("blur", cleanup)
    window.addEventListener("keydown", key, true)
    dragCleanup = cleanup
  }
  onCleanup(() => dragCleanup?.())
  const pager = (more: () => Promise<unknown>, loading: () => boolean) => {
    const [visibility, setVisibility] = createStore({ intersecting: false, pending: false })
    let disposed = false
    createEffect(() => {
      if (!visibility.intersecting || visibility.pending || loading() || state.error) return
      untrack(() => {
        setVisibility("pending", true)
        void more()
          .catch(fail)
          .finally(() => {
            if (!disposed) setVisibility("pending", false)
          })
      })
    })
    onCleanup(() => {
      disposed = true
    })
    return (
      <div
        class="bb-org-pager"
        aria-live="polite"
        ref={(node) => {
          const observer = new IntersectionObserver(
            (entries) => {
              setVisibility(
                "intersecting",
                entries.some((entry) => entry.isIntersecting),
              )
            },
            { root: scrollElement, rootMargin: "0px 0px 80px 0px" },
          )
          observer.observe(node)
          onCleanup(() => observer.disconnect())
        }}
      >
        {language.t("organization.loading")}
      </div>
    )
  }
  const chatRow = (chat: ChatProject.Chat) => {
    const [menu, setMenu] = createStore({
      open: false,
      anchor: undefined as undefined | { x: number; y: number; width: number; height: number },
    })
    const openContext = (x: number, y: number) => setMenu({ open: true, anchor: { x, y, width: 0, height: 0 } })
    return (
      <MenuV2
        open={menu.open}
        onOpenChange={(open) => setMenu("open", open)}
        placement={menu.anchor ? "bottom-start" : "bottom-end"}
        getAnchorRect={() => menu.anchor}
      >
        <div
          class="bb-org-row"
          classList={{ active: activeID() === chat.id, unread: unread(chat), dragging: state.drag?.id === chat.id }}
          data-session-id={chat.id}
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
            openContext(event.clientX, event.clientY)
          }}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return
            event.preventDefault()
            event.stopPropagation()
            const rect = event.currentTarget.getBoundingClientRect()
            openContext(rect.x + 24, rect.y + rect.height)
          }}
        >
          <button
            class="bb-org-chat-link"
            onClick={() => {
              if (!suppressClick) openChat(chat)
            }}
            onPointerDown={(event) => startDrag(event, chat)}
            title={chat.title}
            aria-current={activeID() === chat.id ? "page" : undefined}
          >
            <i class="bb-org-status" aria-hidden="true" />
            <span>{chat.title}</span>
          </button>
          <MenuV2.Trigger
            class="bb-org-more"
            aria-label={language.t("organization.chatActions")}
            onPointerDown={() => setMenu("anchor", undefined)}
          >
            <Icon name="dot-grid" size="small" />
          </MenuV2.Trigger>
        </div>
        <MenuV2.Portal>
          <MenuV2.Content class="bb-org-chat-menu">
            <MenuV2.Item
              onSelect={() => setState("dialog", { kind: "rename", id: chat.id, value: chat.title, directory: "" })}
            >
              <Icon name="edit" size="small" />
              {language.t("organization.rename")}
            </MenuV2.Item>
            <MenuV2.Item onSelect={() => updateChat(chat, { pinned: !chat.pinned })}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="m6 2 6 6-2 1-1 3-5-5 3-1 1-2ZM6 10l-4 4"
                  stroke="currentColor"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              {language.t(chat.pinned ? "organization.unpin" : "organization.pin")}
            </MenuV2.Item>
            <MenuV2.Item onSelect={() => markRead(chat)}>
              <Icon name="eye" size="small" />
              {language.t(unread(chat) ? "organization.markRead" : "organization.markUnread")}
            </MenuV2.Item>
            <MenuV2.Sub>
              <MenuV2.SubTrigger>
                <Icon name="folder" size="small" />
                {language.t("organization.project")}
              </MenuV2.SubTrigger>
              <MenuV2.Portal>
                <MenuV2.SubContent class="bb-org-chat-menu">
                  <MenuV2.Item onSelect={() => void moveChat(chat, "")}>
                    <Icon name="folder" size="small" />
                    {language.t("organization.unassigned")}
                  </MenuV2.Item>
                  <For each={orderedProjects()}>
                    {(project) => (
                      <MenuV2.Item onSelect={() => void moveChat(chat, project.id)}>
                        <Icon name="folder" size="small" />
                        {project.name}
                      </MenuV2.Item>
                    )}
                  </For>
                  <MenuV2.Separator />
                  <MenuV2.Item
                    onSelect={() => setState("dialog", { kind: "project", value: "", directory: "", moveID: chat.id })}
                  >
                    <Icon name="plus-small" size="small" />
                    {language.t("organization.newProject")}
                  </MenuV2.Item>
                </MenuV2.SubContent>
              </MenuV2.Portal>
            </MenuV2.Sub>
            <MenuV2.Separator />
            <MenuV2.Item onSelect={() => actOnChat(chat, "fork")}>
              <Icon name="branch" size="small" />
              {language.t("organization.fork")}
            </MenuV2.Item>
            <MenuV2.Sub>
              <MenuV2.SubTrigger>
                <Icon name="copy" size="small" />
                {language.t("organization.copy")}
              </MenuV2.SubTrigger>
              <MenuV2.Portal>
                <MenuV2.SubContent class="bb-org-chat-menu">
                  <MenuV2.Item onSelect={() => actOnChat(chat, "copyTitle")}>
                    {language.t("organization.copyTitle")}
                  </MenuV2.Item>
                  <MenuV2.Item onSelect={() => actOnChat(chat, "copyConversation")}>
                    {language.t("organization.copyConversation")}
                  </MenuV2.Item>
                </MenuV2.SubContent>
              </MenuV2.Portal>
            </MenuV2.Sub>
            <Show when={platform.openConversationWindow}>
              <MenuV2.Item onSelect={() => openChatWindow(chat)}>
                <Icon name="window-cursor" size="small" />
                {language.t("organization.openWindow")}
              </MenuV2.Item>
            </Show>
            <MenuV2.Separator />
            <MenuV2.Item onSelect={() => updateChat(chat, { archived: !chat.archived })}>
              <Icon name="archive" size="small" />
              {language.t(chat.archived ? "organization.restore" : "organization.archive")}
            </MenuV2.Item>
            <MenuV2.Item
              onSelect={() =>
                setState("dialog", { kind: "delete", id: chat.id, value: chat.title, directory: chat.directory })
              }
            >
              <Icon name="trash" size="small" />
              {language.t("organization.delete")}
            </MenuV2.Item>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    )
  }
  const projectMenu = (project: ChatProject.Info) => (
    <MenuV2 placement="bottom-end">
      <MenuV2.Trigger class="bb-org-more" aria-label={language.t("organization.projectActions")}>
        <Icon name="dot-grid" size="small" />
      </MenuV2.Trigger>
      <MenuV2.Portal>
        <MenuV2.Content>
          <MenuV2.Item onSelect={() => newChat(project)}>{language.t("organization.newChat")}</MenuV2.Item>
          <MenuV2.Item
            onSelect={() =>
              setState("dialog", {
                kind: "project",
                id: project.id,
                value: project.name,
                directory: project.directory ?? "",
              })
            }
          >
            {language.t("organization.renameProject")}
          </MenuV2.Item>
          <MenuV2.Item
            onSelect={() =>
              setState("dialog", {
                kind: "project",
                id: project.id,
                value: project.name,
                directory: project.directory ?? "",
                folder: true,
              })
            }
          >
            {language.t("organization.defaultFolder")}
          </MenuV2.Item>
          <MenuV2.Item onSelect={() => void mutate(client()!.update(project.id, { pinned: !project.pinned }))}>
            {language.t(project.pinned ? "organization.unpin" : "organization.pin")}
          </MenuV2.Item>
          <MenuV2.Item onSelect={() => void mutate(client()!.remove(project.id))}>
            {language.t("organization.removeProject")}
          </MenuV2.Item>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
  return (
    <div
      class="bb-organization-shell"
      style={{ "--organization-width": `${Math.max(260, Math.min(420, saved.width))}px` }}
    >
      <Show when={state.drawer}>
        <button class="bb-org-backdrop" aria-label={language.t("organization.close")} onClick={closeDrawer} />
      </Show>
      <aside
        class="bb-org-sidebar"
        classList={{ collapsed: saved.collapsed, drawer: state.drawer }}
        role={state.drawer ? "dialog" : undefined}
        aria-modal={state.drawer ? true : undefined}
        aria-label={language.t("organization.navigation")}
        onKeyDown={(event) => {
          if (event.key === "Escape" && state.drawer) {
            event.stopPropagation()
            closeDrawer()
            return
          }
          if (!(event.target instanceof HTMLElement) || event.target.matches("input,select,textarea")) return
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              ".bb-org-chat-link,.bb-org-project-link,.bb-org-utility",
            ),
          ].filter((button) => button.offsetParent)
          const index = buttons.indexOf(event.target.closest("button")!)
          if (index < 0) return
          event.preventDefault()
          buttons[
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))
          ]?.focus()
        }}
      >
        <nav class="bb-org-utilities">
          <button class="bb-org-utility" classList={{ active: state.view === "chat" }} onClick={home}>
            <Icon name="bubble-5" size="small" />
            {language.t("organization.home")}
          </button>
          <Show when={platform.bitsbytes}>
            <button
              class="bb-org-utility"
              classList={{ active: state.view === "recordings" }}
              onClick={() => setView("recordings")}
            >
              <Icon name="status" size="small" />
              {language.t("organization.recordings")}
            </button>
            <button
              class="bb-org-utility"
              classList={{ active: state.view === "skills" }}
              onClick={() => setView("skills")}
            >
              <Icon name="brain" size="small" />
              {language.t("organization.skills")}
            </button>
            <button
              class="bb-org-utility"
              classList={{ active: state.view === "artifacts" }}
              onClick={() => {
                setView("artifacts")
                void platform
                  .bitsbytes!.call<Artifact[]>("artifacts.list")
                  .then((artifacts) => setState("artifacts", artifacts))
                  .catch(fail)
              }}
            >
              <Icon name="photo" size="small" />
              {language.t("organization.artifacts")}
            </button>
          </Show>
        </nav>
        <div class="bb-org-chat-navigation" style={{ display: state.view === "chat" ? "flex" : "none" }}>
          <button class="bb-org-utility bb-org-new-chat" onClick={() => newChat()}>
            <Icon name="plus-small" size="small" />
            {language.t("organization.newChat")}
          </button>
          <div class="bb-org-scroll" ref={scrollElement}>
            <Show when={!state.archived && !state.search}>
              <div class="bb-org-heading bb-org-heading-actions">
                <span>{language.t("organization.projects")}</span>
                <button
                  aria-label={language.t("organization.newProject")}
                  onClick={() => setState("dialog", { kind: "project", value: "", directory: "" })}
                >
                  <Icon name="plus-small" size="small" />
                </button>
              </div>
              <For each={orderedProjects()}>
                {(project) => (
                  <section data-project-id={project.id}>
                    <div
                      class="bb-org-row"
                      data-project-drop={project.id}
                      classList={{ "drop-target": state.drag?.target === project.id }}
                    >
                      <button
                        class="bb-org-project-link"
                        aria-expanded={saved.expanded[project.id] !== false}
                        onClick={() => {
                          const expanded = saved.expanded[project.id] === false
                          setSaved("expanded", project.id, expanded)
                          if (expanded) void loadChildren(project.id).catch(fail)
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                            event.preventDefault()
                            setSaved("expanded", project.id, event.key === "ArrowRight")
                            if (event.key === "ArrowRight") void loadChildren(project.id).catch(fail)
                          }
                        }}
                      >
                        <Icon name="folder" size="small" />
                        <span>{project.name}</span>
                      </button>
                      {projectMenu(project)}
                    </div>
                    <Show when={saved.expanded[project.id] !== false}>
                      <div class="bb-org-children">
                        <For each={state.children[project.id]?.data}>{chatRow}</For>
                        <Show when={state.children[project.id]?.next}>
                          {pager(
                            () => loadChildren(project.id, true),
                            () => state.childLoading[project.id],
                          )}
                        </Show>
                        <Show when={!state.childLoading[project.id] && !state.children[project.id]?.data.length}>
                          <button class="bb-org-more-rows" onClick={() => newChat(project)}>
                            {language.t("organization.newChat")}
                          </button>
                        </Show>
                      </div>
                    </Show>
                  </section>
                )}
              </For>
              <Show when={state.pinned.length}>
                <div class="bb-org-heading">{language.t("organization.pinnedChats")}</div>
              </Show>
              <For each={state.pinned}>{chatRow}</For>
              <Show when={state.pinnedNext}>
                {pager(
                  () => loadPins(true),
                  () => state.loading,
                )}
              </Show>
            </Show>
            <div class="bb-org-heading bb-org-heading-actions">
              <span>{language.t("organization.recents")}</span>
              <button
                aria-label={language.t("organization.search")}
                onClick={() => {
                  setState("searchOpen", !state.searchOpen)
                  queueMicrotask(() => searchInput?.focus())
                }}
              >
                <Icon name="magnifying-glass" size="small" />
              </button>
              <MenuV2>
                <MenuV2.Trigger aria-label={language.t("organization.filter")}>
                  <Icon name="sliders" size="small" />
                </MenuV2.Trigger>
                <MenuV2.Portal>
                  <MenuV2.Content>
                    <MenuV2.Item onSelect={() => setState("sort", "updated")}>
                      {language.t("organization.updated")}
                    </MenuV2.Item>
                    <MenuV2.Item onSelect={() => setState("sort", "created")}>
                      {language.t("organization.created")}
                    </MenuV2.Item>
                    <MenuV2.Item onSelect={() => setState("archived", !state.archived)}>
                      {language.t(state.archived ? "organization.showActive" : "organization.showArchived")}
                    </MenuV2.Item>
                  </MenuV2.Content>
                </MenuV2.Portal>
              </MenuV2>
            </div>
            <Show when={state.searchOpen}>
              <input
                ref={searchInput}
                class="bb-org-search"
                aria-label={language.t("organization.search")}
                placeholder={language.t("organization.search")}
                value={state.search}
                onInput={(event) => setState("search", event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setState({ search: "", searchOpen: false })
                }}
              />
            </Show>
            <For each={visibleRecents()}>{chatRow}</For>
            <Show when={!state.loading && !visibleRecents().length}>
              <p class="bb-org-empty">{language.t("organization.noChats")}</p>
            </Show>
            <Show when={state.next}>
              {pager(
                () => refresh(true),
                () => state.loading,
              )}
            </Show>
            <Show when={state.drag}>
              <div
                class="bb-org-unassign"
                data-project-drop=""
                classList={{ "drop-target": state.drag?.target === "" }}
              >
                {language.t("organization.removeFromProject")}
              </div>
            </Show>
          </div>
        </div>
        <footer class="bb-org-account">
          <button onClick={settings}>
            <span class="bb-org-avatar">
              {(state.account || language.t("bitsbytes.brand")).slice(0, 1).toUpperCase()}
            </span>
            <span>{state.account || language.t("bitsbytes.brand")}</span>
            <Icon name="chevron-down" size="small" />
          </button>
          <button
            title={language.t("organization.settings")}
            aria-label={language.t("organization.settings")}
            onClick={settings}
          >
            <Icon name="settings-gear" size="small" />
          </button>
        </footer>
        <ResizeHandle
          direction="horizontal"
          edge="end"
          size={saved.width}
          min={260}
          max={420}
          onResize={(width) => setSaved("width", width)}
        />
      </aside>
      <main class="bb-org-main">
        <Show when={state.error}>
          <div class="bb-org-error" role="alert">
            {state.error}
            <button
              onClick={() => {
                void refresh()
                void retryAssignments()
              }}
            >
              {language.t("organization.retry")}
            </button>
          </div>
        </Show>
        <div class="bb-org-chat-content" style={{ display: state.view === "chat" ? "flex" : "none" }}>
          {props.children}
        </div>
        <div
          id="bitsbytes-utility-content"
          class="bb-org-utility-content"
          style={{ display: state.view === "skills" || state.view === "recordings" ? "flex" : "none" }}
        />
        <Show when={state.view === "artifacts"}>
          <section class="bb-org-page">
            <header>
              <h1>{language.t("organization.artifacts")}</h1>
            </header>
            <For each={state.artifacts}>
              {(artifact) => (
                <button
                  class="bb-org-artifact"
                  onClick={() => {
                    const token = generation
                    void context()
                      ?.sdk.api.session.get({ sessionID: artifact.sessionID })
                      .then((info) => {
                        if (disposed || token !== generation) return
                        pendingArtifact = artifact
                        if (artifactTimeout) clearTimeout(artifactTimeout)
                        artifactTimeout = setTimeout(() => {
                          pendingArtifact = undefined
                          fail(undefined)
                        }, 20_000)
                        openChat({
                          id: artifact.sessionID as ChatProject.Chat["id"],
                          directory: AbsolutePath.make(info.location.directory),
                        })
                        queueMicrotask(tryPendingArtifact)
                      })
                      .catch(fail)
                  }}
                >
                  <Icon name={artifact.kind === "image" ? "photo" : "open-file"} />
                  <span>{artifact.filename}</span>
                </button>
              )}
            </For>
          </section>
        </Show>
        <Show when={state.dialog}>
          {(dialog) => (
            <div
              class="bb-org-modal"
              role="presentation"
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) setState("dialog", undefined)
              }}
            >
              <form
                role="dialog"
                aria-modal="true"
                aria-label={language.t(
                  dialog().kind === "project"
                    ? "organization.editProject"
                    : dialog().kind === "rename"
                      ? "organization.rename"
                      : "organization.delete",
                )}
                onSubmit={saveDialog}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation()
                    setState("dialog", undefined)
                  }
                  if (event.key !== "Tab") return
                  const controls = [
                    ...event.currentTarget.querySelectorAll<HTMLElement>(
                      "button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex='0']",
                    ),
                  ]
                  const first = controls[0],
                    last = controls.at(-1)
                  if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault()
                    last?.focus()
                  }
                  if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault()
                    first?.focus()
                  }
                }}
              >
                <h2>
                  {language.t(
                    dialog().kind === "project"
                      ? "organization.editProject"
                      : dialog().kind === "rename"
                        ? "organization.rename"
                        : "organization.delete",
                  )}
                </h2>
                <Show
                  when={dialog().kind === "delete"}
                  fallback={
                    <label>
                      {language.t("organization.name")}
                      <input
                        autofocus
                        value={dialog().value}
                        maxlength={dialog().kind === "project" ? 120 : 300}
                        onInput={(event) => setState("dialog", "value", event.currentTarget.value)}
                      />
                    </label>
                  }
                >
                  <p>{language.t("organization.deleteConfirm", { title: dialog().value })}</p>
                </Show>
                <Show when={dialog().kind === "project"}>
                  <details open={dialog().folder}>
                    <summary>{language.t("organization.workspace")}</summary>
                    <label>
                      {language.t("organization.workspace")}
                      <input
                        value={dialog().directory}
                        placeholder={language.t("organization.defaultWorkspace")}
                        onInput={(event) => setState("dialog", "directory", event.currentTarget.value)}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() =>
                        pickDirectory({
                          server: currentServer(),
                          onSelect: (result) => {
                            const value = Array.isArray(result) ? result[0] : result
                            if (value) setState("dialog", "directory", value)
                          },
                        })
                      }
                    >
                      {language.t("organization.chooseFolder")}
                    </button>
                    <p>{language.t("organization.workspaceHint")}</p>
                  </details>
                </Show>
                <div class="bb-org-dialog-actions">
                  <button type="button" onClick={() => setState("dialog", undefined)}>
                    {language.t("organization.cancel")}
                  </button>
                  <button type="submit">
                    {language.t(dialog().kind === "delete" ? "organization.deleteAction" : "organization.save")}
                  </button>
                </div>
              </form>
            </div>
          )}
        </Show>
      </main>
      <Show when={state.drag}>
        {(drag) => (
          <Portal>
            <div class="bb-org-drag-preview" style={{ left: `${drag().x + 14}px`, top: `${drag().y + 12}px` }}>
              <Icon name="bubble-5" size="small" />
              <span>{drag().title}</span>
            </div>
          </Portal>
        )}
      </Show>
    </div>
  )
}
