import { For, Show, Switch, Match, createEffect, onCleanup, onMount, untrack, type JSX } from "solid-js"
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
import { useSync } from "../../context/sync"
import { useSessionLayout } from "./session-layout"
import { TerminalPanelV2 } from "./terminal-panel-v2"
import { SessionFileView } from "./file-tabs"
import { showToast } from "../../utils/toast"
import { sideChatContextKey } from "./side-chat-context"
import { PanelToggle } from "./panel-toggle"
import { usePrompt } from "../../context/prompt"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { sampledChecksum } from "@opencode-ai/core/util/encode"
import type { FollowupDraft } from "../../components/prompt-input/submit"
import { readPanelState, savePanelState, type PanelTab } from "./chat-workspace-state"
import "./chat-workspace.css"

type SideChatSource = { source: string; directory: string; model?: { providerID: string; modelID: string }; agent?: string; variant: string | null; draft?: FollowupDraft }
export function ChatWorkspace(props: { sessionID?: string; chat: (headerActions: JSX.Element) => JSX.Element; review: () => JSX.Element; sideChat: (id: string) => JSX.Element }) {
  const platform = usePlatform(), language = useLanguage(), sdk = useSDK(), file = useFile(), local = useLocal(), sync = useSync()
  const session = useSessionLayout()
  const prompt = usePrompt()
  const [store, setStore] = createStore({ tabs: [] as PanelTab[], active: "", collapsed: true, menu: false, width: 520, busy: false })
  const catalog = new Map<string, { id: string; sessionID: string; filename: string; revision?: number; kind?: string; path?: string; turnID?: string; history?: { revision: number; source: string }[] }>()
  const owner = () => props.sessionID ?? `draft:${sdk().directory}`
  const active = () => store.tabs.find(tab => tab.id === store.active)
  const fail = (error: unknown) => showToast({ variant: "error", title: language.t("common.requestFailed"), description: String(error) })
  const loadFile = (path: string) => file.load(file.pathFromTab(file.tab(path)) ?? path)
  const select = (id: string) => { setStore({ active: id, collapsed: false }); setStore("tabs", tab => tab.id === id, "unread", false) }
  const add = (tab: PanelTab, focus = true) => {
    if (!store.tabs.some(row => row.id === tab.id)) setStore("tabs", rows => [...rows, { ...tab, unread: !focus }])
    else if ((["document", "code"].includes(tab.kind) && store.tabs.find(row => row.id === tab.id)?.revision !== tab.revision) || (tab.kind === "file" && store.tabs.find(row => row.id === tab.id)?.path !== tab.path)) setStore("tabs", row => row.id === tab.id, { ...tab, previewRevision: 0, unread: store.active !== tab.id })
    if (focus) select(tab.id)
    else if (!store.active) setStore("active", tab.id)
  }
  const close = (tab: PanelTab) => {
    if (tab.kind === "file") session.tabs().close(tab.id)
    if (tab.kind === "browser") void platform.bitsbytes!.call("browser.close", { id: tab.id }).catch(fail)
    setStore("tabs", rows => rows.filter(row => row.id !== tab.id))
    if (store.active === tab.id) setStore("active", store.tabs.at(-1)?.id ?? "")
    if (tab.kind === "terminal") session.view().terminal.close()
  }
  let savedKey = ""
  let savedWritable = true
  createEffect(() => {
    const key = `bitsbytes.panels.v2:${sdk().directory}:${owner()}`
    if (key === savedKey) return
    savedKey = key
    const stored = readPanelState(localStorage, key, Math.max(400, window.innerWidth * .7))
    savedWritable = stored.writable
    setStore(reconcile({ ...stored.value, menu: false, busy: false }))
  })
  createEffect(() => {
    const value = { tabs: store.tabs.filter(tab => tab.kind !== "browser"), active: store.active, collapsed: store.collapsed, open: !store.collapsed, width: store.width }
    if (savedKey && savedWritable) savePanelState(localStorage, savedKey, value)
  })
  const artifact = (item: { id: string; sessionID: string; filename: string; revision?: number; kind?: string; path?: string; turnID?: string; history?: { revision: number; source: string }[] }, published = false) => {
    catalog.set(item.id, item)
    window.dispatchEvent(new CustomEvent("bitsbytes:artifact-change", { detail: [...catalog.values()] }))
    if (item.sessionID !== owner() && !store.tabs.some(tab => tab.kind === "chat" && tab.id === item.sessionID)) return
    add({ id: item.id, kind: item.kind === "code" ? "code" : "document", path: item.path, title: item.filename, owner: item.sessionID, revision: item.revision }, published && item.sessionID === owner())
  }
  onMount(() => {
    const unsubscribe = platform.bitsbytes!.subscribe(event => {
      if (event.type === "artifact") artifact(event.artifact as Parameters<typeof artifact>[0], event.published === true)
      if (event.type === "browser" && (event.sessionID === owner() || store.tabs.some(tab => tab.kind === "chat" && tab.id === event.sessionID))) {
        if (event.closed) { setStore("tabs", rows => rows.filter(tab => tab.id !== event.id)); if (store.active === event.id) setStore("active", store.tabs.at(-1)?.id ?? ""); return }
        const existing = store.tabs.some(tab => tab.id === event.id)
        if (!existing) add({ id: String(event.id), kind: "browser", title: String(event.title || language.t("bitsbytes.browser")), owner: String(event.sessionID) }, !store.active)
        else setStore("tabs", tab => tab.id === event.id, "title", String(event.title || language.t("bitsbytes.browser")))
      }
    })
    const attachment = (event: Event) => {
      const item = (event as CustomEvent).detail
      if (item.sessionID && item.sessionID !== owner() && !store.tabs.some(tab => tab.id === item.sessionID)) return
      const uri = item.uri ?? `bitsbytes://${item.attachment.kind}/${encodeURIComponent(item.attachment.id)}${item.attachment.revision === undefined ? "" : `?revision=${item.attachment.revision}`}`
      add({ id: uri, kind: "source", title: item.attachment?.name ?? item.name, owner: item.sessionID ?? owner(), uri })
    }
    const openDocument = (event: Event) => { const detail = (event as CustomEvent).detail; void platform.bitsbytes!.call("artifact.publish", { path: detail.path, sessionID: detail.sessionID ?? owner() }).catch(fail) }
    window.addEventListener("bitsbytes:open-document", openDocument)
    onCleanup(() => window.removeEventListener("bitsbytes:open-document", openDocument))
    window.addEventListener("bitsbytes:attachment", attachment)
    const query = (event: Event) => (event as CustomEvent<{ receive: (items: unknown[]) => void }>).detail.receive([...catalog.values()])
    const openArtifact = (event: Event) => { const detail = (event as CustomEvent).detail; const item = catalog.get(detail.id); if (!item || detail.handled) return; if (item.sessionID !== owner() && !store.tabs.some(tab => tab.id === item.sessionID)) return; detail.handled = true; artifact(item); const version = item.history?.find(row => row.revision === detail.revision); setStore("tabs", tab => tab.id === item.id, { previewRevision: version?.revision ?? 0 }); select(item.id) }
    window.addEventListener("bitsbytes:artifact-query", query)
    window.addEventListener("bitsbytes:open-artifact", openArtifact)
    const fileLink = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return
      const link = event.target.closest("a[href]")
      if (!link || link.closest("[data-bb-chat]")?.getAttribute("data-bb-chat") !== owner()) return
      const href = link.getAttribute("href") ?? ""
      if (!/^(?:\/?[A-Za-z]:[\\/]|\\\\|file:\/\/)/.test(href)) return
      event.preventDefault(); event.stopPropagation()
      const path = decodeURIComponent(href.replace(/^file:\/\//, "").replace(/^\/([A-Za-z]:)/, "$1").replace(/:\d+$/, ""))
      void platform.bitsbytes!.call<Parameters<typeof artifact>[0]>("artifact.publish", { path, sessionID: owner() }).then(item => { artifact(item); select(item.id) }).catch(fail)
    }
    window.addEventListener("click", fileLink, true)
    onCleanup(() => { window.removeEventListener("bitsbytes:artifact-query", query); window.removeEventListener("bitsbytes:open-artifact", openArtifact); window.removeEventListener("click", fileLink, true) })
    const runPanel = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionID: string; kind: "plan" | "goal" }>).detail
      if (detail.sessionID !== owner() && !store.tabs.some(tab => tab.id === detail.sessionID)) return
      add({ id: `${detail.kind}:${detail.sessionID}`, kind: detail.kind, title: language.t(detail.kind === "plan" ? "bitsbytes.plan" : "bitsbytes.goal"), owner: detail.sessionID })
    }
    const proposal = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionID: string; text: string; implement?: boolean; handled?: boolean }>).detail
      if (detail.handled || (detail.sessionID !== owner() && !store.tabs.some(tab => tab.id === detail.sessionID))) return
      detail.handled = true
      void platform.bitsbytes!.call<{ plan?: { revision: number } }>("runs.plan", detail).then(value => {
        if (detail.implement) return platform.bitsbytes!.call("runs.implement", { sessionID: detail.sessionID, revision: value.plan?.revision })
        runPanel(new CustomEvent("bitsbytes:run-panel", { detail: { kind: "plan", sessionID: detail.sessionID } }))
      }).catch(fail)
    }
    window.addEventListener("bitsbytes:run-panel", runPanel)
    window.addEventListener("bitsbytes:plan-proposal", proposal)
    onCleanup(() => { window.removeEventListener("bitsbytes:run-panel", runPanel); window.removeEventListener("bitsbytes:plan-proposal", proposal) })
    const sideChat = (event: Event) => {
      const detail = (event as CustomEvent<SideChatSource>).detail
      if (detail.directory !== sdk().directory || (detail.source !== owner() && !store.tabs.some(tab => tab.kind === "chat" && tab.id === detail.source))) return
      void open("chat", detail)
    }
    window.addEventListener("bitsbytes:side-chat", sideChat)
    onCleanup(() => window.removeEventListener("bitsbytes:side-chat", sideChat))
    onCleanup(() => { unsubscribe(); window.removeEventListener("bitsbytes:attachment", attachment); for (const tab of store.tabs) if (tab.kind === "browser") void platform.bitsbytes!.call("browser.hide", { id: tab.id }).catch(() => undefined) })
  })
  createEffect(() => { owner(); void platform.bitsbytes!.call<Parameters<typeof artifact>[0][]>("artifacts.list").then(rows => rows.forEach(row => artifact(row))).catch(fail) })
  createEffect(() => {
    const identity = owner()
    void platform.bitsbytes!.call<{ id: string; sessionID: string; title: string }[]>("browser.list").then(rows => {
      if (owner() !== identity) return
      for (const row of rows) if (row.sessionID === identity) add({ id: row.id, kind: "browser", title: row.title || language.t("bitsbytes.browser"), owner: identity }, !store.active)
    }).catch(fail)
  })
  // Keep native file/terminal shortcuts connected to this single panel.
  createEffect(() => {
    const files = session.tabs().all().map(id => ({ id, path: file.pathFromTab(id) }))
    const current = session.tabs().active(), identity = owner()
    // Panel updates must not reselect a previously opened native file tab.
    untrack(() => {
      for (const { id, path } of files) if (path) add({ id, kind: "file", title: path.split(/[\\/]/).at(-1)!, path, owner: identity }, current === id)
    })
  })
  createEffect(() => { if (session.view().terminal.opened() && !store.tabs.some(tab => tab.kind === "terminal")) add({ id: "terminal", kind: "terminal", title: language.t("bitsbytes.terminal"), owner: owner() }) })
  async function open(kind: "chat" | "browser" | "terminal" | "review" | "file", inherited?: SideChatSource) {
    if (store.busy) return
    setStore({ menu: false, busy: true })
    try {
      if (kind === "terminal") { session.view().terminal.open(); add({ id: "terminal", kind, title: language.t("bitsbytes.terminal"), owner: owner() }); return }
      if (kind === "review") { add({ id: "review", kind, title: language.t("bitsbytes.review"), owner: owner() }); return }
      if (kind === "browser") { const browser = await platform.bitsbytes!.call<{ id: string; title: string }>("browser.open", { sessionID: owner() }); add({ id: browser.id, kind, title: browser.title || language.t("bitsbytes.browser"), owner: owner() }); return }
      if (kind === "file") {
        const paths = await platform.bitsbytes!.call<string | null>("pick.file")
        const path = Array.isArray(paths) ? paths[0] : paths
        if (!path) return
        if (/\.(docx|pptx|xlsx|pdf|csv|html?)$/i.test(path)) { const doc = await platform.bitsbytes!.call<{ id: string; filename: string }>("artifact.publish", { path, sessionID: owner() }); add({ id: doc.id, kind: "document", title: doc.filename, owner: owner() }); return }
        const id = file.tab(path); await loadFile(path); session.tabs().open(id); add({ id, kind, path, title: path.split(/[\\/]/).at(-1)!, owner: owner() }); return
      }
      const source = inherited?.source ?? props.sessionID
      if (!source) return
      const directory = sdk().directory, workspaceOwner = owner(), api = sdk().api
      const current = local.model.current()
      const selection = inherited ?? { model: current ? { providerID: current.provider.id, modelID: current.id } : undefined, agent: local.agent.current()?.name, variant: local.model.variant.current() ?? null }
      const access = await platform.bitsbytes!.call<{ mode: string }>("access.get", { sessionID: source })
      const messages = sync().data.message[source] ?? []
      const completed = messages.findLastIndex(message => message.role === "assistant" && message.time.completed && message.finish && !["tool-calls", "unknown"].includes(message.finish))
      const boundary = messages[completed + 1]?.id
      const fork = await api.session.fork({ sessionID: source, messageID: boundary })
      localStorage.setItem(sideChatContextKey(directory, fork.id), String(fork.time.created))
      await platform.bitsbytes!.call("access.set", { sessionID: fork.id, mode: access.mode })
      await platform.bitsbytes!.call("runs.inherit", { from: source, sessionID: fork.id })
      local.session.promote(directory, fork.id, { agent: selection.agent, model: selection.model, variant: selection.variant })
      if (inherited?.draft) {
        const target = prompt.capture({ dir: base64Encode(directory), id: fork.id })
        target.set(inherited.draft.prompt)
        for (const item of inherited.draft.context) target.context.add(item)
      }
      if (owner() === workspaceOwner) add({ id: fork.id, kind, title: language.t("bitsbytes.sideChat"), owner: source })
    } catch (error) { fail(error) }
    finally { setStore("busy", false) }
  }
  const panelMenu = () => <MenuV2 placement="bottom-end" gutter={6} open={store.menu} onOpenChange={menu => setStore("menu", menu)}>
    <MenuV2.Trigger as={IconButtonV2} variant="ghost-muted" size="normal" icon={<Icon name="plus-small" />}
      aria-label={language.t("bitsbytes.panel")} title={language.t("bitsbytes.panel")} disabled={store.busy}
      onContextMenu={event => { event.preventDefault(); setStore("menu", true) }} />
    <MenuV2.Portal><MenuV2.Content>
      <For each={[{ kind: "chat", label: "bitsbytes.sideChat", icon: "bubble-5" }, { kind: "browser", label: "bitsbytes.browser", icon: "window-cursor" }, { kind: "terminal", label: "bitsbytes.terminal", icon: "console" }, { kind: "review", label: "bitsbytes.review", icon: "branch" }, { kind: "file", label: "bitsbytes.file", icon: "open-file" }] as const}>
        {item => <MenuV2.Item disabled={item.kind === "chat" && !props.sessionID} onSelect={() => void open(item.kind)}>
          <Icon name={item.icon} />{language.t(item.label)}
        </MenuV2.Item>}
      </For>
    </MenuV2.Content></MenuV2.Portal>
  </MenuV2>
  const panelToggle = () => <PanelToggle expanded={!store.collapsed} onToggle={() => setStore({ collapsed: !store.collapsed, menu: false })} />
  return <div class="bb-workspace">
    <div class="bb-workspace-chat" data-bb-chat={owner()}>{props.chat(panelToggle())}</div>
    <Show when={store.tabs.length || !store.collapsed}><aside class="bb-workspace-panel" style={{ width: store.collapsed ? "0px" : `${store.width}px`, display: store.collapsed ? "none" : "flex" }}><ResizeHandle direction="horizontal" edge="start" size={store.width} min={340} max={Math.max(400, window.innerWidth * .7)} onResize={width => setStore("width", width)} />
      <div class="bb-panel-header">
        <div class="bb-panel-tabs" role="tablist"><For each={store.tabs}>{tab => <div classList={{ active: tab.id === store.active }}>
          <button role="tab" aria-label={tab.title} aria-selected={tab.id === store.active} title={tab.title} onClick={() => select(tab.id)}>{tab.title}<Show when={tab.unread}><span class="bb-unread" aria-hidden="true">•</span></Show></button>
          <button aria-label={language.t("bitsbytes.close")} title={language.t("bitsbytes.close")} onClick={() => close(tab)}><Icon name="close-small" /></button>
        </div>}</For></div>
        <Show when={!store.collapsed}><div class="bb-panel-add">{panelMenu()}</div></Show>
      </div>
      <div class="bb-panel-body"><For each={store.tabs}>{tab => <div class="bb-panel-content" style={{ display: tab.id === store.active ? "flex" : "none" }}><Switch>
        <Match when={tab.kind === "chat"}>{props.sideChat(tab.id)}</Match>
        <Match when={tab.kind === "terminal"}><TerminalPanelV2 /></Match>
        <Match when={tab.kind === "review"}>{props.review()}</Match>
        <Match when={tab.kind === "file"}><SessionFileView tab={tab.path ? file.tab(tab.path) : tab.id} /></Match>
        <Match when={tab.kind === "code"}><ArtifactCodePanel id={tab.id} name={tab.title} revision={tab.previewRevision} /></Match>
        <Match when={tab.kind === "document" && platform.documentPanel}><Dynamic component={platform.documentPanel} id={tab.id} revision={tab.previewRevision} /></Match>
        <Match when={tab.kind === "browser" && platform.browserPanel}><Dynamic component={platform.browserPanel} id={tab.id} active={!store.collapsed && tab.id === store.active} /></Match>
        <Match when={tab.kind === "source"}><SourcePanel uri={tab.uri!} /></Match>
        <Match when={(tab.kind === "plan" || tab.kind === "goal") && platform.runPanel}><Dynamic component={platform.runPanel} sessionID={tab.owner} kind={tab.kind as "plan" | "goal"} /></Match>
      </Switch></div>}</For></div>
    </aside></Show>
  </div>
}

function ArtifactCodePanel(props: { id: string; name: string; revision?: number }) {
  const platform = usePlatform(), language = useLanguage(), component = useFileComponent()
  const [store, setStore] = createStore({ text: "", error: "", loaded: false })
  let generation = 0
  const load = async () => {
    const token = ++generation
    try { const value = await platform.bitsbytes!.call<{ text: string }>("artifact.content", { id: props.id, revision: props.revision || undefined }); if (token === generation) setStore({ text: value.text, loaded: true, error: "" }) }
    catch (error) { if (token === generation) setStore("error", String(error)) }
  }
  createEffect(() => { props.id; props.revision; void load() })
  const unsubscribe = platform.bitsbytes!.subscribe(event => { if (event.type === "artifact" && (event.artifact as { id: string }).id === props.id) void load() })
  onCleanup(() => { generation++; unsubscribe() })
  return <div style={{ overflow: "auto", height: "100%" }}><Show when={store.loaded} fallback={<p>{language.t("common.loading")}</p>}><Dynamic component={component} mode="text" file={{ name: props.name, contents: store.text, cacheKey: `${props.id}:${sampledChecksum(store.text)}` }} /></Show><Show when={store.error}><p role="alert">{store.error}</p></Show></div>
}

function SourcePanel(props: { uri: string }) {
  const platform = usePlatform(), language = useLanguage()
  const [store, setStore] = createStore({ text: language.t("bitsbytes.loading") })
  createEffect(() => { void platform.bitsbytes!.call<{ text: string }>("attachment.read", { uri: props.uri }).then(result => setStore("text", result.text)).catch(error => setStore("text", String(error))) })
  return <pre class="bb-source-panel">{store.text}</pre>
}
