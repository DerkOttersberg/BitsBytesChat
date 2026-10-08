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
import { Persist, persisted } from "@/utils/persist"
import { createOrganizationClient } from "@/utils/organization-api"
import "./organization-shell.css"

type View = "chat" | "projects" | "all" | "artifacts" | "skills" | "recordings"
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
    pickDirectory = useDirectoryPicker()
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
    selected: "",
    loading: false,
    error: "",
    dialog: undefined as
      | undefined
      | { kind: "project" | "rename" | "move"; id?: string; value: string; directory: string },
    artifacts: [] as Artifact[],
    account: "",
    defaultDirectory: "",
    searchOpen: false,
  })
  const currentServer = createMemo(() => server.current ?? global.servers.list()[0])
  const client = createMemo(() =>
    currentServer() ? createOrganizationClient(currentServer()!.http, platform.fetch) : undefined,
  )
  const context = createMemo(() => (currentServer() ? global.ensureServerCtx(currentServer()!) : undefined))
  const activeID = createMemo(() => location.pathname.match(/\/session\/([^/]+)$/)?.[1])
  const currentProject = createMemo(() => state.projects.find((item) => item.id === state.selected))
  let generation = 0,
    queryGeneration = 0,
    pinnedGeneration = 0,
    disposed = false,
    refreshTimer: ReturnType<typeof setTimeout> | undefined
  const childQueries = new Map<string, number>()
  let searchInput: HTMLInputElement | undefined
  let pendingArtifact: Artifact | undefined
  let artifactTimeout: ReturnType<typeof setTimeout> | undefined
  let openingArtifact = false
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
    void tabs.newDraft({ server: ServerConnection.key(conn), directory, projectID: project?.id }, "", model)
  }
  const loadChildren = async (id: string, more = false) => {
    const api = client(),
      token = generation
    if (!api) return
    const request = (childQueries.get(id) ?? 0) + 1
    childQueries.set(id, request)
    const page = await api.chats({ projectID: id, cursor: more ? state.children[id]?.next : undefined })
    if (disposed || token !== generation || childQueries.get(id) !== request) return
    setState(
      "children",
      id,
      reconcile(
        {
          ...page,
          data: more
            ? [...new Map([...(state.children[id]?.data ?? []), ...page.data].map((chat) => [chat.id, chat])).values()]
            : [...page.data],
        },
        { key: "id" },
      ),
    )
  }
  const loadPins = async (more = false) => {
    const api = client(),
      token = generation,
      request = ++pinnedGeneration
    if (!api) return
    const page = await api.chats({ pinned: true, limit: 100, cursor: more ? state.pinnedNext : undefined })
    if (disposed || token !== generation || request !== pinnedGeneration) return
    setState(
      "pinned",
      reconcile(
        more ? [...new Map([...state.pinned, ...page.data].map((chat) => [chat.id, chat])).values()] : [...page.data],
        { key: "id" },
      ),
    )
    setState("pinnedNext", page.next ?? "")
  }
  const refresh = async (more = false) => {
    const api = client(),
      token = generation
    if (!api) return
    const request = ++queryGeneration
    setState("loading", true)
    try {
      const [projects, page] = await Promise.all([
        api.projects(),
        api.chats({
          search: state.search,
          archived: state.archived,
          sort: state.sort,
          cursor: more ? state.next : undefined,
        }),
        loadPins(),
      ])
      if (disposed || token !== generation || request !== queryGeneration) return
      // Keep row owners (and their open menus/focus) through background refreshes.
      setState("projects", reconcile([...projects], { key: "id" }))
      setState(
        "chats",
        reconcile(
          more ? [...new Map([...state.chats, ...page.data].map((chat) => [chat.id, chat])).values()] : [...page.data],
          { key: "id" },
        ),
      )
      setState({
        next: page.next ?? "",
        error: "",
      })
      await Promise.all(
        projects
          .filter(
            (project) => (project.pinned && saved.expanded[project.id] !== false) || project.id === state.selected,
          )
          .map((project) => loadChildren(project.id)),
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
    try {
      await action
      await refresh()
    } catch (error) {
      fail(error)
    }
  }
  const updateChat = (chat: ChatProject.Chat, value: ChatProject.ChatUpdate) => {
    const api = client()
    if (!api) return
    void mutate(
      api.chat(chat.id, value).then((next) => {
        const cached = context()?.sync.session.peek(chat.id)
        if (cached)
          context()?.sync.session.remember({
            ...cached,
            title: next.title,
            time: { ...cached.time, archived: next.archived },
          })
        if (value.archived) {
          tabs.removeSessionTab({ server: ServerConnection.key(currentServer()!), sessionId: chat.id })
          if (activeID() === chat.id) navigate("/")
        }
      }),
    )
  }
  const selectProject = (id: string) => {
    setState({ selected: id, search: "", archived: false })
    setView("projects")
    void refresh()
  }
  const saveDialog = async (event: SubmitEvent) => {
    event.preventDefault()
    const dialog = state.dialog,
      api = client()
    if (!dialog || !api) return
    try {
      if (dialog.kind === "project") {
        const value = {
          name: dialog.value,
          directory: dialog.directory ? AbsolutePath.make(dialog.directory) : undefined,
        }
        if (dialog.id) await api.update(dialog.id, { ...value, directory: value.directory ?? null })
        else {
          const project = await api.create(value)
          setSaved("expanded", project.id, true)
        }
      }
      if (dialog.kind === "rename" && dialog.id) {
        const updated = await api.chat(dialog.id, { title: dialog.value })
        const cached = context()?.sync.session.peek(dialog.id)
        if (cached) context()?.sync.session.remember({ ...cached, title: updated.title })
      }
      if (dialog.kind === "move" && dialog.id) {
        await api.chat(dialog.id, { projectID: dialog.value || null })
        tabs.projectAssigned(dialog.id)
      }
      setState("dialog", undefined)
      await refresh()
    } catch (error) {
      fail(error)
    }
  }
  const retryAssignments = async () => {
    const conn = currentServer(),
      api = client()
    if (!conn || !api) return
    for (const tab of tabs.store) {
      if (
        tab.type !== "session" ||
        !tab.pendingProjectID ||
        tab.server !== ServerConnection.key(conn) ||
        pending.has(tab.sessionId)
      )
        continue
      pending.add(tab.sessionId)
      try {
        await api.chat(tab.sessionId, { projectID: tab.pendingProjectID })
        tabs.projectAssigned(tab.sessionId)
        schedule()
      } catch (error) {
        fail(error)
      } finally {
        pending.delete(tab.sessionId)
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
    setState({ projects: [], chats: [], children: {}, pinned: [], pinnedNext: "", next: "" })
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
    void init().catch(fail)
    const unsubscribe = context()?.sdk.event.listen((event) => {
      const type = event.details.type
      if (
        type === "session.created" ||
        type === "session.updated" ||
        type === "session.deleted" ||
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
    const timer = setTimeout(() => void refresh(), 160)
    onCleanup(() => clearTimeout(timer))
  })
  createEffect(() => {
    const pathname = location.pathname
    untrack(() => {
      if (pathname !== "/") {
        setView("chat")
        closeDrawer()
        queueMicrotask(tryPendingArtifact)
      }
    })
  })
  createEffect(() => {
    if (!state.dialog) return
    const previous = document.activeElement
    const frame = requestAnimationFrame(() =>
      document.querySelector<HTMLInputElement>(".bb-org-modal input,.bb-org-modal select")?.focus(),
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
      newChat(state.view === "projects" ? currentProject() : undefined, (event as CustomEvent).detail?.model)
    }
    window.dispatchEvent(
      new CustomEvent("bitsbytes:utility-host", { detail: document.getElementById("bitsbytes-utility-content") }),
    )
    window.addEventListener("bitsbytes:sidebar-toggle", toggle)
    window.addEventListener("bitsbytes:utility-state", utility)
    window.addEventListener("bitsbytes:new-chat", createChat)
    window.addEventListener("bitsbytes:artifact-change", tryPendingArtifact)
    onCleanup(() => {
      disposed = true
      generation++
      if (refreshTimer) clearTimeout(refreshTimer)
      if (artifactTimeout) clearTimeout(artifactTimeout)
      window.removeEventListener("bitsbytes:sidebar-toggle", toggle)
      window.removeEventListener("bitsbytes:utility-state", utility)
      window.removeEventListener("bitsbytes:new-chat", createChat)
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
  const pinnedProjectIDs = createMemo(
    () => new Set(state.projects.filter((project) => project.pinned).map((project) => project.id)),
  )
  const visibleRecents = createMemo(() =>
    state.chats.filter(
      (chat) =>
        state.search ||
        state.archived ||
        (!chat.pinned && (!chat.projectID || !pinnedProjectIDs().has(chat.projectID))),
    ),
  )
  const chatMenu = (chat: ChatProject.Chat) => (
    <MenuV2 placement="bottom-end">
      <MenuV2.Trigger class="bb-org-more" aria-label={language.t("organization.chatActions")}>
        <Icon name="dot-grid" size="small" />
      </MenuV2.Trigger>
      <MenuV2.Portal>
        <MenuV2.Content>
          <MenuV2.Item onSelect={() => updateChat(chat, { pinned: !chat.pinned })}>
            {language.t(chat.pinned ? "organization.unpin" : "organization.pin")}
          </MenuV2.Item>
          <MenuV2.Item
            onSelect={() => setState("dialog", { kind: "rename", id: chat.id, value: chat.title, directory: "" })}
          >
            {language.t("organization.rename")}
          </MenuV2.Item>
          <MenuV2.Item
            onSelect={() =>
              setState("dialog", { kind: "move", id: chat.id, value: chat.projectID ?? "", directory: "" })
            }
          >
            {language.t("organization.move")}
          </MenuV2.Item>
          <MenuV2.Item onSelect={() => updateChat(chat, { archived: !chat.archived })}>
            {language.t(chat.archived ? "organization.restore" : "organization.archive")}
          </MenuV2.Item>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
  const chatRow = (chat: ChatProject.Chat) => (
    <div class="bb-org-row" classList={{ active: activeID() === chat.id }} data-session-id={chat.id}>
      <button
        class="bb-org-chat-link"
        onClick={() => openChat(chat)}
        title={chat.title}
        aria-current={activeID() === chat.id ? "page" : undefined}
      >
        <i class="bb-org-status" aria-hidden="true" />
        <span>{chat.title}</span>
      </button>
      {chatMenu(chat)}
    </div>
  )
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
            {language.t("organization.editProject")}
          </MenuV2.Item>
          <MenuV2.Item onSelect={() => void mutate(client()!.update(project.id, { pinned: !project.pinned }))}>
            {language.t(project.pinned ? "organization.unpin" : "organization.pin")}
          </MenuV2.Item>
          <MenuV2.Item
            onSelect={() =>
              void mutate(
                client()!
                  .remove(project.id)
                  .then(() => {
                    if (state.selected === project.id) setState("selected", "")
                  }),
              )
            }
          >
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
          <button class="bb-org-utility" onClick={() => newChat()}>
            <Icon name="plus-small" size="small" />
            {language.t("organization.new")}
          </button>
          <button
            class="bb-org-utility"
            onClick={() => {
              setView("chat")
              navigate("/")
            }}
          >
            <Icon name="bubble-5" size="small" />
            {language.t("organization.home")}
          </button>
          <button
            class="bb-org-utility"
            classList={{ active: state.view === "projects" }}
            onClick={() => {
              setState("selected", "")
              setView("projects")
              void refresh()
            }}
          >
            <Icon name="folder" size="small" />
            {language.t("organization.projects")}
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
        <div class="bb-org-scroll">
          <Show when={state.projects.some((project) => project.pinned) || state.pinned.length}>
            <div class="bb-org-heading">{language.t("organization.pinned")}</div>
            <For each={state.projects.filter((project) => project.pinned)}>
              {(project) => (
                <section>
                  <div class="bb-org-row">
                    <button
                      class="bb-org-project-link"
                      aria-expanded={saved.expanded[project.id] !== false}
                      onClick={() => {
                        const expanded = saved.expanded[project.id] === false
                        setSaved("expanded", project.id, expanded)
                        if (expanded) void loadChildren(project.id).catch(fail)
                      }}
                      onDblClick={() => selectProject(project.id)}
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
                        <button
                          class="bb-org-more-rows"
                          onClick={() => void loadChildren(project.id, true).catch(fail)}
                        >
                          {language.t("organization.more")}
                        </button>
                      </Show>
                      <Show when={!state.children[project.id]?.data.length}>
                        <button class="bb-org-more-rows" onClick={() => newChat(project)}>
                          {language.t("organization.newChat")}
                        </button>
                      </Show>
                    </div>
                  </Show>
                </section>
              )}
            </For>
            <For each={state.pinned.filter((chat) => !chat.projectID || !pinnedProjectIDs().has(chat.projectID))}>
              {chatRow}
            </For>
            <Show when={state.pinnedNext}>
              <button class="bb-org-more-rows" onClick={() => void loadPins(true).catch(fail)}>
                {language.t("organization.more")}
              </button>
            </Show>
          </Show>
          <div class="bb-org-heading bb-org-heading-actions">
            <span>{language.t("organization.chats")}</span>
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
          <For each={tabs.store.filter((tab) => tab.type === "draft")}>
            {(tab) => (
              <Show when={tab.type === "draft"}>
                <div class="bb-org-row">
                  <button
                    class="bb-org-chat-link"
                    onClick={() => {
                      setView("chat")
                      tabs.select(tab)
                    }}
                  >
                    <i class="bb-org-status" />
                    <span>{language.t("organization.draft")}</span>
                  </button>
                </div>
              </Show>
            )}
          </For>
          <For each={visibleRecents()}>{chatRow}</For>
          <Show when={!state.loading && !visibleRecents().length}>
            <p class="bb-org-empty">{language.t("organization.noChats")}</p>
          </Show>
          <button
            class="bb-org-more-rows"
            onClick={() => {
              setState("selected", "")
              setView("all")
              void refresh()
            }}
          >
            {language.t("organization.viewAll")}
          </button>
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
        <Show when={state.view === "projects" || state.view === "all"}>
          <section class="bb-org-page">
            <header>
              <h1>
                {state.view === "projects"
                  ? currentProject()?.name || language.t("organization.projects")
                  : language.t("organization.chats")}
              </h1>
              <Show when={state.view === "projects"}>
                <button
                  onClick={() =>
                    state.selected
                      ? newChat(currentProject())
                      : setState("dialog", { kind: "project", value: "", directory: "" })
                  }
                >
                  <Icon name="plus-small" size="small" />
                  {language.t(state.selected ? "organization.newChat" : "organization.newProject")}
                </button>
              </Show>
            </header>
            <Show
              when={state.view === "projects" && !state.selected}
              fallback={
                <>
                  <For
                    each={
                      state.view === "projects" && state.selected ? state.children[state.selected]?.data : state.chats
                    }
                  >
                    {chatRow}
                  </For>
                  <Show
                    when={
                      state.view === "projects" && state.selected ? state.children[state.selected]?.next : state.next
                    }
                  >
                    <button
                      class="bb-org-more-rows"
                      disabled={state.loading}
                      onClick={() =>
                        state.view === "projects" && state.selected
                          ? void loadChildren(state.selected, true).catch(fail)
                          : void refresh(true)
                      }
                    >
                      {language.t("organization.more")}
                    </button>
                  </Show>
                </>
              }
            >
              <div class="bb-org-project-grid">
                <For each={state.projects}>
                  {(project) => (
                    <article>
                      <button class="bb-org-project-card" onClick={() => selectProject(project.id)}>
                        <Icon name="folder" />
                        <strong>{project.name}</strong>
                        <span>{language.plural("organization.chatCount", project.count)}</span>
                      </button>
                      {projectMenu(project)}
                    </article>
                  )}
                </For>
              </div>
              <Show when={!state.projects.length}>
                <p class="bb-org-empty">{language.t("organization.noProjects")}</p>
              </Show>
            </Show>
          </section>
        </Show>
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
                      : "organization.move",
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
                        : "organization.move",
                  )}
                </h2>
                <Show
                  when={dialog().kind === "move"}
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
                  <label>
                    {language.t("organization.projects")}
                    <select
                      value={dialog().value}
                      onChange={(event) => setState("dialog", "value", event.currentTarget.value)}
                    >
                      <option value="">{language.t("organization.unassigned")}</option>
                      <For each={state.projects}>{(project) => <option value={project.id}>{project.name}</option>}</For>
                    </select>
                  </label>
                </Show>
                <Show when={dialog().kind === "project"}>
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
                </Show>
                <div class="bb-org-dialog-actions">
                  <button type="button" onClick={() => setState("dialog", undefined)}>
                    {language.t("organization.cancel")}
                  </button>
                  <button type="submit">{language.t("organization.save")}</button>
                </div>
              </form>
            </div>
          )}
        </Show>
      </main>
    </div>
  )
}
