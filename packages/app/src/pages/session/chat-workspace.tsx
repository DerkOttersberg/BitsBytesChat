import {
  For,
  Show,
  Switch,
  Match,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
  type JSX,
} from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { Icon } from "@opencode-ai/ui/icon"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { usePlatform } from "../../context/platform"
import { useLanguage } from "../../context/language"
import { useSDK } from "../../context/sdk"
import { useFile } from "../../context/file"
import { useLocal } from "../../context/local"
import { useSessionLayout } from "./session-layout"
import { TerminalPanelV2 } from "./terminal-panel-v2"
import { SessionFileView } from "./file-tabs"
import { showToast } from "../../utils/toast"
import { PanelToggle } from "./panel-toggle"
import { usePrompt } from "../../context/prompt"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { sampledChecksum } from "@opencode-ai/core/util/encode"
import type { FollowupDraft } from "../../components/prompt-input/submit"
import { readPanelState, savePanelState, workspacePanelLayout, type PanelTab } from "./chat-workspace-state"
import { isMarkdownName, MarkdownArtifactPanel } from "./markdown-panel"
import { RecordedImagePanel } from "./recorded-image-panel"
import "./chat-workspace.css"

type SideChatSource = {
  source: string
  directory: string
  model?: { providerID: string; modelID: string }
  agent?: string
  variant: string | null
  draft?: FollowupDraft
}
export function ChatWorkspace(props: {
  sessionID?: string
  chat: (headerActions: JSX.Element) => JSX.Element
  review: () => JSX.Element
  sideChat: (id: string) => JSX.Element
}) {
  const platform = usePlatform(),
    language = useLanguage(),
    sdk = useSDK(),
    file = useFile(),
    local = useLocal()
  const session = useSessionLayout()
  const prompt = usePrompt()
  const [store, setStore] = createStore({
    tabs: [] as PanelTab[],
    active: "",
    collapsed: true,
    menu: false,
    width: 520,
    busy: false,
  })
  let workspace!: HTMLDivElement
  const [workspaceWidth, setWorkspaceWidth] = createSignal(0)
  const panelLayout = createMemo(() => workspacePanelLayout(workspaceWidth(), store.width))
  onMount(() => {
    const update = () => setWorkspaceWidth(workspace.getBoundingClientRect().width)
    const observer = new ResizeObserver(update)
    observer.observe(workspace)
    update()
    onCleanup(() => observer.disconnect())
  })
  const catalog = new Map<
    string,
    {
      id: string
      sessionID: string
      filename: string
      revision?: number
      kind?: string
      path?: string
      turnID?: string
      history?: { revision: number; source: string }[]
    }
  >()
  const owner = () => props.sessionID ?? `draft:${sdk().directory}`
  let generation = 0
  onCleanup(() => generation++)
  const active = () => store.tabs.find((tab) => tab.id === store.active)
  const fail = (error: unknown) =>
    showToast({ variant: "error", title: language.t("common.requestFailed"), description: String(error) })
  const loadFile = (path: string) => file.load(file.pathFromTab(file.tab(path)) ?? path)
  const select = (id: string) => {
    setStore({ active: id, collapsed: false })
    setStore("tabs", (tab) => tab.id === id, "unread", false)
  }
  const add = (tab: PanelTab, focus = true) => {
    if (!store.tabs.some((row) => row.id === tab.id)) setStore("tabs", (rows) => [...rows, { ...tab, unread: !focus }])
    else if (
      (["document", "code"].includes(tab.kind) &&
        store.tabs.find((row) => row.id === tab.id)?.revision !== tab.revision) ||
      (tab.kind === "file" && store.tabs.find((row) => row.id === tab.id)?.path !== tab.path)
    )
      setStore("tabs", (row) => row.id === tab.id, { ...tab, previewRevision: 0, unread: store.active !== tab.id })
    if (focus) select(tab.id)
    else if (!store.active) setStore("active", tab.id)
  }
  const close = (tab: PanelTab) => {
    if (tab.kind === "chat") {
      const workspaceOwner = owner()
      const token = generation
      void platform
        .bitsbytes!.call("side.close", { sessionID: tab.id, ownerID: tab.owner || workspaceOwner })
        .then(() => {
          if (token !== generation) return
          remove(tab.id)
        })
        .catch((error) => {
          if (token === generation) fail(error)
        })
      return
    }
    if (tab.kind === "file") session.tabs().close(tab.id)
    if (tab.kind === "browser") void platform.bitsbytes!.call("browser.close", { id: tab.id }).catch(fail)
    // Close the terminal's source state before removing its tab, otherwise the
    // open-terminal effect can recreate the tab during the removal update.
    if (tab.kind === "terminal") session.view().terminal.close()
    remove(tab.id)
  }
  const remove = (id: string) => {
    const index = store.tabs.findIndex((tab) => tab.id === id)
    const tabs = store.tabs.filter((tab) => tab.id !== id)
    setStore({
      tabs,
      active: store.active === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? "") : store.active,
      ...(!tabs.length ? { active: "", collapsed: true, menu: false } : {}),
    })
  }
  let savedKey = ""
  let savedWritable = true
  createEffect(() => {
    const key = `bitsbytes.panels.v2:${sdk().directory}:${owner()}`
    if (key === savedKey) return
    generation++
    // Temporary diagnostics belong to the workspace that opened them. Capture
    // that ownership before switching sessions and replacing the visible tabs.
    for (const tab of untrack(() => [...store.tabs]))
      if (tab.kind === "chat" && tab.owner)
        void platform.bitsbytes!.call("side.close", { sessionID: tab.id, ownerID: tab.owner }).catch(() => undefined)
    savedKey = key
    const stored = readPanelState(localStorage, key)
    savedWritable = stored.writable
    const tabs = stored.value.tabs.filter((tab) => tab.kind !== "chat")
    setStore(
      reconcile({
        ...stored.value,
        tabs,
        collapsed: !tabs.length || stored.value.collapsed,
        active: tabs.some((tab) => tab.id === stored.value.active) ? stored.value.active : (tabs.at(-1)?.id ?? ""),
        menu: false,
        busy: false,
      }),
    )
  })
  createEffect(() => {
    const value = {
      tabs: store.tabs.filter((tab) => tab.kind !== "browser" && tab.kind !== "chat"),
      active: store.active,
      collapsed: store.collapsed,
      open: !store.collapsed,
      width: store.width,
    }
    if (savedKey && savedWritable) savePanelState(localStorage, savedKey, value)
  })
  const artifact = (
    item: {
      id: string
      sessionID: string
      filename: string
      revision?: number
      kind?: string
      path?: string
      turnID?: string
      history?: { revision: number; source: string }[]
    },
    published = false,
  ) => {
    catalog.set(item.id, item)
    window.dispatchEvent(new CustomEvent("bitsbytes:artifact-change", { detail: [...catalog.values()] }))
    if (item.sessionID !== owner() && !store.tabs.some((tab) => tab.kind === "chat" && tab.id === item.sessionID))
      return
    add(
      {
        id: item.id,
        kind: item.kind === "code" ? "code" : "document",
        path: item.path,
        title: item.filename,
        owner: item.sessionID,
        revision: item.revision,
      },
      published && item.sessionID === owner(),
    )
  }
  onMount(() => {
    const recordedImage = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (!detail || detail.handled || typeof detail.sessionID !== "string") return
      const imageOwner = detail.sessionID
      const belongs = () =>
        imageOwner === owner() ||
        store.tabs.some((tab) => tab.kind === "chat" && tab.id === imageOwner && tab.owner === owner())
      if (!belongs()) return
      detail.handled = true
      const token = generation,
        identity = owner()
      void platform
        .bitsbytes!.call<{ id: string }>("image.snapshot", detail)
        .then((image) => {
          if (generation !== token || owner() !== identity || !belongs() || !/^[a-f0-9]{64}$/.test(image.id)) return
          add({
            id: "read-image:" + image.id,
            kind: "image",
            title: String(detail.filename || language.t("organization.image")),
            owner: imageOwner,
            uri: image.id,
          })
        })
        .catch(fail)
    }
    window.addEventListener("bitsbytes:open-recorded-image", recordedImage)
    onCleanup(() => window.removeEventListener("bitsbytes:open-recorded-image", recordedImage))
    const unsubscribe = platform.bitsbytes!.subscribe((event) => {
      if (event.type === "artifact")
        artifact(event.artifact as Parameters<typeof artifact>[0], event.published === true)
      if (
        event.type === "browser" &&
        (event.sessionID === owner() || store.tabs.some((tab) => tab.kind === "chat" && tab.id === event.sessionID))
      ) {
        if (event.closed) {
          remove(String(event.id))
          return
        }
        const existing = store.tabs.some((tab) => tab.id === event.id)
        if (!existing)
          add(
            {
              id: String(event.id),
              kind: "browser",
              title: String(event.title || language.t("bitsbytes.browser")),
              owner: String(event.sessionID),
            },
            !store.active,
          )
        else
          setStore(
            "tabs",
            (tab) => tab.id === event.id,
            "title",
            String(event.title || language.t("bitsbytes.browser")),
          )
      }
    })
    const attachment = (event: Event) => {
      const item = (event as CustomEvent).detail
      if (item.sessionID && item.sessionID !== owner() && !store.tabs.some((tab) => tab.id === item.sessionID)) return
      const uri =
        item.uri ??
        `bitsbytes://${item.attachment.kind}/${encodeURIComponent(item.attachment.id)}${item.attachment.revision === undefined ? "" : `?revision=${item.attachment.revision}`}`
      add({ id: uri, kind: "source", title: item.attachment?.name ?? item.name, owner: item.sessionID ?? owner(), uri })
    }
    const openDocument = (event: Event) => {
      const detail = (event as CustomEvent).detail
      void platform
        .bitsbytes!.call("artifact.publish", { path: detail.path, sessionID: detail.sessionID ?? owner() })
        .catch(fail)
    }
    window.addEventListener("bitsbytes:open-document", openDocument)
    onCleanup(() => window.removeEventListener("bitsbytes:open-document", openDocument))
    window.addEventListener("bitsbytes:attachment", attachment)
    const source = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionID: string; url?: string }>).detail
      if (!detail.url || (detail.sessionID !== owner() && !store.tabs.some((tab) => tab.id === detail.sessionID)))
        return
      const workspaceOwner = owner()
      const token = generation
      void platform
        .bitsbytes!.call<{ id: string; title: string }>("browser.open", { sessionID: workspaceOwner, url: detail.url })
        .then(async (browser) => {
          if (token !== generation) {
            await platform.bitsbytes!.call("browser.close", { id: browser.id })
            return
          }
          add({
            id: browser.id,
            kind: "browser",
            title: browser.title || language.t("bitsbytes.browser"),
            owner: workspaceOwner,
          })
        })
        .catch((error) => {
          if (token === generation) fail(error)
        })
    }
    window.addEventListener("bitsbytes:source", source)
    onCleanup(() => window.removeEventListener("bitsbytes:source", source))
    const query = (event: Event) =>
      (event as CustomEvent<{ receive: (items: unknown[]) => void }>).detail.receive([...catalog.values()])
    const openArtifact = (event: Event) => {
      const detail = (event as CustomEvent).detail
      const item = catalog.get(detail.id)
      if (!item || detail.handled) return
      if (item.sessionID !== owner() && !store.tabs.some((tab) => tab.id === item.sessionID)) return
      detail.handled = true
      artifact(item)
      const version = item.history?.find((row) => row.revision === detail.revision)
      setStore("tabs", (tab) => tab.id === item.id, { previewRevision: version?.revision ?? 0 })
      select(item.id)
    }
    window.addEventListener("bitsbytes:artifact-query", query)
    window.addEventListener("bitsbytes:open-artifact", openArtifact)
    const fileLink = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return
      const link = event.target.closest("a[href]")
      if (!link || link.closest("[data-bb-chat]")?.getAttribute("data-bb-chat") !== owner()) return
      const href = link.getAttribute("href") ?? ""
      if (!/^(?:\/?[A-Za-z]:[\\/]|\\\\|file:\/\/)/.test(href)) return
      event.preventDefault()
      event.stopPropagation()
      const path = decodeURIComponent(
        href
          .replace(/^file:\/\//, "")
          .replace(/^\/([A-Za-z]:)/, "$1")
          .replace(/:\d+$/, ""),
      )
      const token = generation
      void platform
        .bitsbytes!.call<Parameters<typeof artifact>[0]>("artifact.publish", { path, sessionID: owner() })
        .then((item) => {
          if (token !== generation) return
          artifact(item)
          select(item.id)
        })
        .catch((error) => {
          if (token === generation) fail(error)
        })
    }
    window.addEventListener("click", fileLink, true)
    onCleanup(() => {
      window.removeEventListener("bitsbytes:artifact-query", query)
      window.removeEventListener("bitsbytes:open-artifact", openArtifact)
      window.removeEventListener("click", fileLink, true)
    })
    const runPanel = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionID: string; kind: "plan" | "goal" }>).detail
      if (detail.kind !== "plan") return
      if (detail.sessionID !== owner() && !store.tabs.some((tab) => tab.id === detail.sessionID)) return
      add({
        id: `${detail.kind}:${detail.sessionID}`,
        kind: detail.kind,
        title: language.t(detail.kind === "plan" ? "bitsbytes.plan" : "bitsbytes.goal"),
        owner: detail.sessionID,
      })
    }
    const proposal = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionID: string; text: string; implement?: boolean; handled?: boolean }>)
        .detail
      if (detail.handled || (detail.sessionID !== owner() && !store.tabs.some((tab) => tab.id === detail.sessionID)))
        return
      detail.handled = true
      const token = generation
      void platform
        .bitsbytes!.call<{ plan?: { revision: number } }>("runs.plan", detail)
        .then((value) => {
          if (detail.implement)
            return platform.bitsbytes!.call("runs.implement", {
              sessionID: detail.sessionID,
              revision: value.plan?.revision,
            })
          if (token !== generation) return
          runPanel(new CustomEvent("bitsbytes:run-panel", { detail: { kind: "plan", sessionID: detail.sessionID } }))
        })
        .catch((error) => {
          if (token === generation) fail(error)
        })
    }
    window.addEventListener("bitsbytes:run-panel", runPanel)
    window.addEventListener("bitsbytes:plan-proposal", proposal)
    onCleanup(() => {
      window.removeEventListener("bitsbytes:run-panel", runPanel)
      window.removeEventListener("bitsbytes:plan-proposal", proposal)
    })
    const sideChat = (event: Event) => {
      const detail = (event as CustomEvent<SideChatSource>).detail
      if (
        detail.directory !== sdk().directory ||
        (detail.source !== owner() && !store.tabs.some((tab) => tab.kind === "chat" && tab.id === detail.source))
      )
        return
      void open("chat", detail)
    }
    window.addEventListener("bitsbytes:side-chat", sideChat)
    onCleanup(() => window.removeEventListener("bitsbytes:side-chat", sideChat))
    onCleanup(() => {
      unsubscribe()
      window.removeEventListener("bitsbytes:attachment", attachment)
      for (const tab of store.tabs) {
        if (tab.kind === "browser") void platform.bitsbytes!.call("browser.hide", { id: tab.id }).catch(() => undefined)
        if (tab.kind === "chat" && tab.owner)
          void platform.bitsbytes!.call("side.close", { sessionID: tab.id, ownerID: tab.owner }).catch(() => undefined)
      }
    })
  })
  createEffect(() => {
    owner()
    void platform
      .bitsbytes!.call<Parameters<typeof artifact>[0][]>("artifacts.list")
      .then((rows) => rows.forEach((row) => artifact(row)))
      .catch(fail)
  })
  createEffect(() => {
    const identity = owner()
    void platform
      .bitsbytes!.call<{ id: string; sessionID: string; title: string }[]>("browser.list")
      .then((rows) => {
        if (owner() !== identity) return
        for (const row of rows)
          if (row.sessionID === identity)
            add(
              { id: row.id, kind: "browser", title: row.title || language.t("bitsbytes.browser"), owner: identity },
              !store.active,
            )
      })
      .catch(fail)
  })
  // Keep native file/terminal shortcuts connected to this single panel.
  createEffect(() => {
    const files = session
      .tabs()
      .all()
      .map((id) => ({ id, path: file.pathFromTab(id) }))
    const current = session.tabs().active(),
      identity = owner()
    // Panel updates must not reselect a previously opened native file tab.
    untrack(() => {
      for (const { id, path } of files)
        if (path) add({ id, kind: "file", title: path.split(/[\\/]/).at(-1)!, path, owner: identity }, current === id)
    })
  })
  createEffect(() => {
    if (session.view().terminal.opened() && !store.tabs.some((tab) => tab.kind === "terminal"))
      add({ id: "terminal", kind: "terminal", title: language.t("bitsbytes.terminal"), owner: owner() })
  })
  async function open(kind: "chat" | "browser" | "terminal" | "review" | "file", inherited?: SideChatSource) {
    if (store.busy) return
    const token = generation
    const workspaceOwner = owner()
    setStore({ menu: false, busy: true })
    try {
      if (kind === "terminal") {
        session.view().terminal.open()
        add({ id: "terminal", kind, title: language.t("bitsbytes.terminal"), owner: owner() })
        return
      }
      if (kind === "review") {
        add({ id: "review", kind, title: language.t("bitsbytes.review"), owner: owner() })
        return
      }
      if (kind === "browser") {
        const browser = await platform.bitsbytes!.call<{ id: string; title: string }>("browser.open", {
          sessionID: workspaceOwner,
        })
        if (token !== generation) {
          await platform.bitsbytes!.call("browser.close", { id: browser.id })
          return
        }
        add({ id: browser.id, kind, title: browser.title || language.t("bitsbytes.browser"), owner: workspaceOwner })
        return
      }
      if (kind === "file") {
        const paths = await platform.bitsbytes!.call<string | null>("pick.file")
        if (token !== generation) return
        const path = Array.isArray(paths) ? paths[0] : paths
        if (!path) return
        if (/\.(docx|pptx|xlsx|pdf|csv|html?)$/i.test(path)) {
          const doc = await platform.bitsbytes!.call<{ id: string; filename: string }>("artifact.publish", {
            path,
            sessionID: workspaceOwner,
          })
          if (token !== generation) return
          add({ id: doc.id, kind: "document", title: doc.filename, owner: workspaceOwner })
          return
        }
        const id = file.tab(path)
        await loadFile(path)
        if (token !== generation) return
        session.tabs().open(id)
        add({ id, kind, path, title: path.split(/[\\/]/).at(-1)!, owner: owner() })
        return
      }
      const source = inherited?.source ?? props.sessionID
      if (!source) return
      const directory = sdk().directory
      const current = local.model.current()
      const selection = inherited ?? {
        model: current ? { providerID: current.provider.id, modelID: current.id } : undefined,
        agent: local.agent.current()?.name,
        variant: local.model.variant.current() ?? null,
      }
      const fork = await platform.bitsbytes!.call<{ id: string }>("side.open", {
        parentID: source,
        ownerID: workspaceOwner,
        directory,
      })
      if (token !== generation) {
        await platform.bitsbytes!.call("side.close", { sessionID: fork.id, ownerID: workspaceOwner })
        return
      }
      local.session.promote(directory, fork.id, {
        agent: selection.agent,
        model: selection.model,
        variant: selection.variant,
      })
      if (inherited?.draft) {
        const target = prompt.capture({ dir: base64Encode(directory), id: fork.id })
        // The queued input remains owned by the parent. The side composer asks
        // about its progress instead of executing another copy of that task.
        target.set([
          {
            type: "text",
            content: language.t("bitsbytes.sideQueuedQuestion"),
            start: 0,
            end: language.t("bitsbytes.sideQueuedQuestion").length,
          },
        ])
      }
      add({ id: fork.id, kind, title: language.t("bitsbytes.sideChat"), owner: workspaceOwner })
    } catch (error) {
      if (token === generation) fail(error)
    } finally {
      if (token === generation) setStore("busy", false)
    }
  }
  const panelMenu = () => (
    <MenuV2 placement="bottom-end" gutter={6} open={store.menu} onOpenChange={(menu) => setStore("menu", menu)}>
      <MenuV2.Trigger
        as={IconButtonV2}
        variant="ghost-muted"
        size="normal"
        icon={<Icon name="plus-small" />}
        aria-label={language.t("bitsbytes.panel")}
        title={language.t("bitsbytes.panel")}
        disabled={store.busy}
        onContextMenu={(event) => {
          event.preventDefault()
          setStore("menu", true)
        }}
      />
      <MenuV2.Portal>
        <MenuV2.Content>
          <For
            each={
              [
                { kind: "chat", label: "bitsbytes.sideChat", icon: "bubble-5" },
                { kind: "browser", label: "bitsbytes.browser", icon: "window-cursor" },
                { kind: "terminal", label: "bitsbytes.terminal", icon: "console" },
                { kind: "review", label: "bitsbytes.review", icon: "branch" },
                { kind: "file", label: "bitsbytes.file", icon: "open-file" },
              ] as const
            }
          >
            {(item) => (
              <MenuV2.Item disabled={item.kind === "chat" && !props.sessionID} onSelect={() => void open(item.kind)}>
                <Icon name={item.icon} />
                {language.t(item.label)}
              </MenuV2.Item>
            )}
          </For>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
  const panelToggle = () => (
    <PanelToggle expanded={!store.collapsed} onToggle={() => setStore({ collapsed: !store.collapsed, menu: false })} />
  )
  const panelTools = () => (
    <div class="bb-panel-tools">
      <h2>{language.t("organization.panelTools")}</h2>
      <div class="bb-panel-tools-grid">
        <button disabled={store.busy || !props.sessionID} onClick={() => void open("chat")}>
          <Icon name="bubble-5" size="small" />
          {language.t("bitsbytes.sideChat")}
        </button>
        <button disabled={store.busy} onClick={() => void open("terminal")}>
          <Icon name="console" size="small" />
          {language.t("bitsbytes.terminal")}
        </button>
        <button disabled={store.busy} onClick={() => void open("browser")}>
          <Icon name="window-cursor" size="small" />
          {language.t("organization.newPage")}
        </button>
        <MenuV2 placement="bottom-end" gutter={6}>
          <MenuV2.Trigger disabled={store.busy}>
            <Icon name="dot-grid" size="small" />
            {language.t("organization.moreTools")}
            <Icon name="chevron-down" size="small" />
          </MenuV2.Trigger>
          <MenuV2.Portal>
            <MenuV2.Content>
              <MenuV2.Item onSelect={() => void open("review")}>
                <Icon name="branch" />
                {language.t("bitsbytes.review")}
              </MenuV2.Item>
              <MenuV2.Item onSelect={() => void open("file")}>
                <Icon name="open-file" />
                {language.t("bitsbytes.file")}
              </MenuV2.Item>
            </MenuV2.Content>
          </MenuV2.Portal>
        </MenuV2>
      </div>
    </div>
  )
  return (
    <div class="bb-workspace" ref={workspace}>
      <div
        class="bb-workspace-chat"
        data-bb-chat={owner()}
        inert={panelLayout().overlay && !store.collapsed}
        aria-hidden={panelLayout().overlay && !store.collapsed ? true : undefined}
      >
        {props.chat(
          <Show when={store.collapsed}>
            <span class="bb-panel-divider" aria-hidden="true" />
            {panelToggle()}
          </Show>,
        )}
      </div>
      <Show when={store.tabs.length || !store.collapsed}>
        <aside
          class="bb-workspace-panel"
          classList={{ "bb-workspace-panel-overlay": panelLayout().overlay }}
          style={{ width: `${panelLayout().width}px`, display: store.collapsed ? "none" : "flex" }}
        >
          <Show when={!panelLayout().overlay}>
            <ResizeHandle
              direction="horizontal"
              edge="start"
              size={panelLayout().width}
              min={340}
              max={panelLayout().maximum}
              onResize={(width) => setStore("width", width)}
            />
          </Show>
          <div class="bb-panel-header">
            <div class="bb-panel-tabs" role="tablist">
              <For each={store.tabs}>
                {(tab) => (
                  <div classList={{ active: tab.id === store.active }}>
                    <button
                      role="tab"
                      aria-label={tab.title}
                      aria-selected={tab.id === store.active}
                      title={tab.title}
                      onClick={() => select(tab.id)}
                    >
                      {tab.title}
                      <Show when={tab.unread}>
                        <span class="bb-unread" aria-hidden="true">
                          •
                        </span>
                      </Show>
                    </button>
                    <button
                      aria-label={language.t("bitsbytes.close")}
                      title={language.t("bitsbytes.close")}
                      onClick={() => close(tab)}
                    >
                      <Icon name="close-small" />
                    </button>
                  </div>
                )}
              </For>
            </div>
            <Show when={!store.collapsed}>
              <div class="bb-panel-add">{panelMenu()}</div>
            </Show>
            <span class="bb-panel-divider" aria-hidden="true" />
            <div class="bb-panel-collapse">{panelToggle()}</div>
          </div>
          <div class="bb-panel-body">
            <Show when={!store.tabs.length}>{panelTools()}</Show>
            <For each={store.tabs}>
              {(tab) => (
                <div class="bb-panel-content" style={{ display: tab.id === store.active ? "flex" : "none" }}>
                  <Switch>
                    <Match when={tab.kind === "chat"}>{props.sideChat(tab.id)}</Match>
                    <Match when={tab.kind === "terminal"}>
                      <TerminalPanelV2 />
                    </Match>
                    <Match when={tab.kind === "review"}>{props.review()}</Match>
                    <Match when={tab.kind === "file"}>
                      <SessionFileView tab={tab.path ? file.tab(tab.path) : tab.id} />
                    </Match>
                    <Match when={tab.kind === "code"}>
                      <Show
                        when={isMarkdownName(tab.title)}
                        fallback={<ArtifactCodePanel id={tab.id} name={tab.title} revision={tab.previewRevision} />}
                      >
                        <MarkdownArtifactPanel
                          id={tab.id}
                          name={tab.title}
                          revision={tab.previewRevision}
                          path={tab.path}
                          sessionID={tab.owner}
                        />
                      </Show>
                    </Match>
                    <Match when={tab.kind === "image" && tab.uri}>
                      <RecordedImagePanel id={tab.uri!} name={tab.title} sessionID={tab.owner} />
                    </Match>
                    <Match when={tab.kind === "document" && platform.documentPanel}>
                      <Dynamic component={platform.documentPanel} id={tab.id} revision={tab.previewRevision} />
                    </Match>
                    <Match when={tab.kind === "browser" && platform.browserPanel}>
                      <Dynamic
                        component={platform.browserPanel}
                        id={tab.id}
                        active={!store.collapsed && tab.id === store.active}
                        home={panelTools()}
                      />
                    </Match>
                    <Match when={tab.kind === "source"}>
                      <SourcePanel uri={tab.uri!} />
                    </Match>
                    <Match when={(tab.kind === "plan" || tab.kind === "goal") && platform.runPanel}>
                      <Dynamic component={platform.runPanel} sessionID={tab.owner} kind={tab.kind as "plan" | "goal"} />
                    </Match>
                  </Switch>
                </div>
              )}
            </For>
          </div>
        </aside>
      </Show>
    </div>
  )
}

function ArtifactCodePanel(props: { id: string; name: string; revision?: number }) {
  const platform = usePlatform(),
    language = useLanguage(),
    component = useFileComponent()
  const [store, setStore] = createStore({ text: "", error: "", loaded: false })
  let generation = 0
  const load = async () => {
    const token = ++generation
    try {
      const value = await platform.bitsbytes!.call<{ text: string }>("artifact.content", {
        id: props.id,
        revision: props.revision || undefined,
      })
      if (token === generation) setStore({ text: value.text, loaded: true, error: "" })
    } catch (error) {
      if (token === generation) setStore("error", String(error))
    }
  }
  createEffect(() => {
    props.id
    props.revision
    void load()
  })
  const unsubscribe = platform.bitsbytes!.subscribe((event) => {
    if (event.type === "artifact" && (event.artifact as { id: string }).id === props.id) void load()
  })
  onCleanup(() => {
    generation++
    unsubscribe()
  })
  return (
    <div style={{ overflow: "auto", height: "100%" }}>
      <Show when={store.loaded} fallback={<p>{language.t("common.loading")}</p>}>
        <Dynamic
          component={component}
          mode="text"
          file={{ name: props.name, contents: store.text, cacheKey: `${props.id}:${sampledChecksum(store.text)}` }}
        />
      </Show>
      <Show when={store.error}>
        <p role="alert">{store.error}</p>
      </Show>
    </div>
  )
}

function SourcePanel(props: { uri: string }) {
  const platform = usePlatform(),
    language = useLanguage()
  const [store, setStore] = createStore({ text: language.t("bitsbytes.loading") })
  createEffect(() => {
    void platform
      .bitsbytes!.call<{ text: string }>("attachment.read", { uri: props.uri })
      .then((result) => setStore("text", result.text))
      .catch((error) => setStore("text", String(error)))
  })
  return <pre class="bb-source-panel">{store.text}</pre>
}
