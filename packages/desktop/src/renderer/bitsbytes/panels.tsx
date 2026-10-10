import { createEffect, For, onCleanup, onMount, Show, untrack, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import type { DocumentArtifact, SpreadsheetGrid } from "../../bitsbytes/types"
import { bbt, bbError } from "../../bitsbytes/copy"
import { WordPreview } from "./preview"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { MarkdownPreviewSource, isMarkdownName } from "@opencode-ai/app"

export function DocumentPanel(props: { id: string; revision?: number }) {
  const api = window.api.bitsbytes
  const [store, setStore] = createStore({ artifact: undefined as DocumentArtifact | undefined, bytes: undefined as Uint8Array | undefined, error: "", text: "", image: "", loading: false, mode: "preview", revision: 0, resourceRevision: 0, resources: [] as { href: string; id?: string }[], sheet: "", offset: 0, pages: [] as number[], grid: undefined as SpreadsheetGrid | undefined })
  let generation = 0
  let identity = ""
  let disposed = false
  async function update(artifact: DocumentArtifact) {
    if (disposed || artifact.id !== props.id) return
    const token = ++generation
    setStore("artifact", artifact)
    if (artifact.status !== "ready" && !(store.revision && artifact.history?.find(version => version.revision === store.revision)?.pdf)) { setStore("loading", false); return }
    setStore("loading", true)
    try {
      const args = { id: props.id, revision: store.revision || undefined, sheet: store.sheet || undefined, offset: store.offset }
      if (artifact.kind === "spreadsheet") {
        const previous = store.grid
        const grid = await api.call<NonNullable<typeof store.grid>>("artifact.content", args)
        if (token === generation) {
          const pages = !previous || previous.sheet !== grid.sheet ? [] : grid.offset > previous.offset
            ? [...store.pages, previous.offset] : store.pages.filter(offset => offset < grid.offset)
          setStore({ grid, sheet: grid.sheet, offset: grid.offset, pages, error: "" })
        }
        return
      }
      if (artifact.kind === "html" || artifact.kind === "code") {
        const content = await api.call<{ text: string; revision?: number; resources?: { href: string; id?: string }[] }>("artifact.content", args)
        if (token === generation) setStore({ text: content.text, error: "", resourceRevision: content.revision ?? store.revision, resources: content.resources ?? [] })
        return
      }
      if (artifact.kind === "image") {
        const content = await api.call<{ data: Uint8Array; mime: string }>("artifact.content", args)
        if (token === generation) { if (store.image) URL.revokeObjectURL(store.image); setStore({ image: URL.createObjectURL(new Blob([new Uint8Array(content.data)], { type: content.mime })), error: "" }) }
        return
      }
      const bytes = await api.call<Uint8Array>("artifact.read", args)
      if (token === generation && bytes) setStore({ bytes, error: "" })
    } catch (error) { if (token === generation) setStore("error", bbError(error)) }
    finally { if (token === generation) setStore("loading", false) }
  }
  onMount(() => {
    const unsubscribe = api.subscribe(event => { if (event.type === "artifact") void update(event.artifact) })
    onCleanup(() => { disposed = true; generation++; unsubscribe(); if (store.image) URL.revokeObjectURL(store.image) })
  })
  const refresh = () => { if (store.artifact) void update(store.artifact) }
  createEffect(() => {
    const id = props.id, revision = props.revision ?? 0
    if (id !== identity) { identity = id; generation++; untrack(() => { if (store.image) URL.revokeObjectURL(store.image) }); setStore({ artifact: undefined, bytes: undefined, text: "", image: "", loading: false, error: "", grid: undefined, sheet: "", mode: "preview" }) }
    const token = ++generation
    setStore({ revision, offset: 0, pages: [], grid: undefined, bytes: undefined, error: "" })
    void api.call<DocumentArtifact[]>("artifacts.list").then(items => { if (disposed || token !== generation || props.id !== id) return; const artifact = items.find(item => item.id === id); if (artifact) void update(artifact) }).catch(error => { if (!disposed && token === generation && props.id === id) setStore("error", bbError(error)) })
  })
  const run = (method: string) => api.call(method, { id: props.id, revision: store.revision || undefined, path: store.artifact?.path }).catch(error => setStore("error", bbError(error)))
  const isolatedHTML = (text: string) => '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob: https:; font-src data:; connect-src \'none\'; form-action \'none\'; base-uri \'none\';">' + text
  return <div class="bb-document-panel">
    <div class="bb-document-toolbar">
      <ButtonV2 variant="ghost-muted" size="normal" onClick={() => void run("file.open")}>{bbt(store.revision && store.revision !== store.artifact?.revision ? store.artifact?.kind === "document" ? "openCurrentWord" : "openCurrentApp" : store.artifact?.kind === "document" ? "openWord" : "openApp")}</ButtonV2>
      <ButtonV2 variant="ghost-muted" size="normal" onClick={() => void run("file.reveal")}>{bbt("showFolder")}</ButtonV2>
      <ButtonV2 variant="ghost-muted" size="normal" onClick={() => void run("artifact.save-copy")}>{bbt("saveCopy")}</ButtonV2>
      <Show when={(store.artifact?.history?.length ?? 0) > 1}><select aria-label={bbt("versions")} value={store.revision} onChange={event => { setStore({ revision: Number(event.currentTarget.value), offset: 0, pages: [], grid: undefined, bytes: undefined, error: "" }); refresh() }}><option value="0" selected={!store.revision}>{bbt("latest")}</option><For each={store.artifact?.history}>{version => <option value={version.revision} selected={store.revision === version.revision}>{bbt("revision").replace("{{revision}}", String(version.revision))}</option>}</For></select></Show>
      <Show when={store.artifact?.kind === "html"}><ButtonV2 variant="ghost-muted" size="normal" onClick={() => setStore("mode", store.mode === "preview" ? "source" : "preview")}>{bbt(store.mode === "preview" ? "source" : "preview")}</ButtonV2></Show>
      <Show when={store.loading || store.artifact?.status === "queued" || store.artifact?.status === "exporting"}><span class="bb-preview-updating" role="status"><i class="bb-preview-spinner" aria-hidden="true" />{bbt("previewUpdating")}</span></Show>
    </div>
    <Show when={store.error || store.artifact?.error}><div class="bb-preview-error" role="alert"><p>{store.error || bbError(store.artifact?.error)}</p><Show when={store.artifact?.status === "error" && ["document", "presentation", "spreadsheet"].includes(store.artifact?.kind ?? "document")}><p>{bbt("previewOriginalSaved")}</p></Show><ButtonV2 variant="ghost-muted" size="normal" onClick={() => void run("artifact.retry")}>{bbt("retryPreview")}</ButtonV2></div></Show>
    <Show when={store.artifact?.kind === "spreadsheet" && store.grid}>{grid => <div class="bb-sheet-panel"><div class="bb-document-toolbar"><select aria-label={bbt("sheet")} value={grid().sheet} disabled={store.loading} onChange={event => { setStore({ sheet: event.currentTarget.value, offset: 0, pages: [], grid: undefined }); refresh() }}><For each={grid().sheets}>{sheet => <option>{sheet}</option>}</For></select><span>{grid().rows.length ? grid().offset + 1 : 0}–{Math.min(grid().total, grid().offset + grid().rows.length)} / {grid().total}</span><ButtonV2 variant="ghost-muted" size="normal" disabled={store.loading || !grid().offset} onClick={() => { setStore("offset", store.pages.at(-1) ?? Math.max(0, grid().offset - 200)); refresh() }}>{bbt("previousRows")}</ButtonV2><ButtonV2 variant="ghost-muted" size="normal" disabled={store.loading || !grid().rows.length || grid().offset + grid().rows.length >= grid().total} onClick={() => { setStore("offset", grid().offset + grid().rows.length); refresh() }}>{bbt("nextRows")}</ButtonV2></div><div class="bb-sheet-scroll"><table><tbody><For each={grid().rows}>{(row, index) => <tr><th>{grid().offset + index() + 1}</th><For each={row}>{(cell, column) => <td title={grid().formulas?.[index()]?.[column()]}>{cell}</td>}</For></tr>}</For></tbody></table></div></div>}</Show>
    <Show when={(store.grid?.columns ?? 0) > 100}><p class="bb-preview-status">{bbt("sheetColumnLimit")}</p></Show>
    <Show when={store.grid?.shortened}><p class="bb-preview-status">{bbt("sheetCellLimit")}</p></Show>
    <Show when={store.artifact?.kind === "html" || store.artifact?.kind === "code"}>
      <Show when={store.artifact?.kind === "code" && isMarkdownName(store.artifact?.filename ?? "")} fallback={<Show when={store.artifact?.kind === "html" && store.mode === "preview"} fallback={<pre class="bb-artifact-source">{store.text}</pre>}><Show when={store.text} keyed>{text => { const url = URL.createObjectURL(new Blob([isolatedHTML(text)], { type: "text/html" })); onCleanup(() => URL.revokeObjectURL(url)); return <iframe class="bb-html-preview" title={bbt("htmlPreview")} sandbox="allow-scripts" src={url} /> }}</Show></Show>}>
        <MarkdownPreviewSource identity={props.id} text={store.text} path={store.artifact?.path} sessionID={store.artifact?.sessionID} artifactID={props.id} revision={store.resourceRevision} resources={store.resources} source={() => <pre class="bb-artifact-source">{store.text}</pre>} />
      </Show>
    </Show>
    <Show when={store.image}><div class="bb-artifact-image"><img src={store.image} alt={store.artifact?.filename ?? ""} /></div></Show>
    <Show when={["document", "presentation", "pdf"].includes(store.artifact?.kind ?? "document")}><Show when={store.bytes} fallback={<div class="bb-preview-status" role="status"><Show when={store.artifact?.status !== "error"}><i class="bb-preview-spinner" aria-hidden="true" /></Show><p>{bbt(store.artifact?.status === "error" ? "previewFailed" : "previewPreparing")}</p></div>}>{bytes => <WordPreview bytes={bytes()} />}</Show></Show>
  </div>
}

export function BrowserPanel(props: { id: string; active: boolean; home?: JSX.Element }) {
  const api = window.api.bitsbytes
  const [store, setStore] = createStore({ url: "", address: "", editing: false, dirty: false, title: "", loading: false, canBack: false, canForward: false, error: "" })
  let host!: HTMLDivElement
  let frame = 0
  let lastBounds = ""
  let generation = 0, disposed = false
  const blank = () => !store.url || store.url === "about:blank"
  const address = () => blank() ? "" : store.url
  const run = async (action: string, args: Record<string, unknown> = {}) => {
    if (action === "navigate") setStore({ editing: false, dirty: false })
    try { await api.call("browser." + action, { id: props.id, ...args }); if (action !== "bounds" && action !== "hide") setStore("error", "") }
    catch (error) { setStore("error", bbError(error)) }
  }
  function bounds() {
    if (!host) return
    const rect = host.getBoundingClientRect()
    const modal = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"],[role="menu"]')).some(element => !!(element as HTMLElement).offsetParent)
    const args = { bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, visible: props.active && !blank() && !modal && rect.width > 0 && rect.height > 0 }
    const key = JSON.stringify(args)
    if (key === lastBounds) return
    lastBounds = key
    void run("bounds", args)
  }
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(bounds) }
  onMount(() => {
    const unsubscribe = api.subscribe(event => { if (event.type === "browser" && event.id === props.id) { generation++; setStore({ url: event.url, ...(!store.editing ? { address: event.url === "about:blank" ? "" : event.url } : {}), title: event.title, loading: event.loading, canBack: event.canBack, canForward: event.canForward }) } })
    const token = generation
    void api.call<{ id: string; url: string; title: string; loading: boolean; canBack: boolean; canForward: boolean }[]>("browser.list").then(items => { if (disposed || token !== generation) return; const item = items.find(item => item.id === props.id); if (item) setStore({ ...item, address: item.url === "about:blank" ? "" : item.url }) }).catch(error => { if (!disposed && token === generation) setStore("error", bbError(error)) })
    const resize = new ResizeObserver(schedule); resize.observe(host)
    const overlay = '[role="dialog"],[aria-modal="true"],[role="menu"]'
    const observer = new MutationObserver(records => {
      if (records.some(record => record.type === "attributes"
        ? record.target instanceof Element && (record.target.matches(overlay) || ["dialog", "menu", "true"].includes(record.oldValue ?? ""))
        : [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && (node.matches(overlay) || node.querySelector(overlay))))) schedule()
    }); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ["role", "aria-modal"] })
    window.addEventListener("resize", schedule)
    onCleanup(() => { disposed = true; generation++; unsubscribe(); resize.disconnect(); observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener("resize", schedule); void api.call("browser.hide", { id: props.id }).catch(() => undefined) })
    bounds()
  })
  createEffect(() => { props.active; store.url; schedule() })
  return (
    <div class="bb-browser-panel">
      <form class="bb-browser-toolbar" onSubmit={event => {
        event.preventDefault()
        void run("navigate", { url: store.address })
      }}>
        <div class="bb-browser-navigation">
          <button type="button" title={bbt("back")} aria-label={bbt("back")} disabled={!store.canBack} onClick={() => void run("back")}>
            <Icon name="arrow-left" size="small" />
          </button>
          <button type="button" title={bbt("forward")} aria-label={bbt("forward")} disabled={!store.canForward} onClick={() => void run("forward")}>
            <Icon name="arrow-right" size="small" />
          </button>
          <span class="bb-browser-divider" aria-hidden="true" />
          <button type="button" title={bbt(store.loading ? "cancel" : "reload")} aria-label={bbt(store.loading ? "cancel" : "reload")} onClick={() => void run(store.loading ? "stop" : "reload")}>
            <Show when={store.loading} fallback={
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M16.67 3.33v5h-5M3.33 16.67v-5h5M4.22 7.5a6.67 6.67 0 0 1 11-2.5l1.45 1.67M3.33 13.33 4.78 15a6.67 6.67 0 0 0 11-2.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            }><Icon name="close-small" size="small" /></Show>
          </button>
        </div>
        <input aria-label={bbt("address")} placeholder={bbt("organization.browserAddressPlaceholder")}
          value={store.address} spellcheck={false} autocomplete="off"
          onFocus={event => { setStore("editing", true); event.currentTarget.select() }}
          onBlur={() => { if (!store.dirty) setStore("editing", false) }}
          onInput={event => { generation++; setStore({ address: event.currentTarget.value, editing: true, dirty: true }) }}
          onKeyDown={event => {
            if (event.key !== "Escape") return
            event.preventDefault()
            event.stopPropagation()
            setStore({ address: address(), editing: false, dirty: false })
            event.currentTarget.blur()
          }} />
        <MenuV2 placement="bottom-end" onOpenChange={schedule}>
          <MenuV2.Trigger type="button" class="bb-browser-actions" aria-label={bbt("organization.browserActions")} title={bbt("organization.browserActions")}>
            <Icon name="dot-grid" size="small" />
          </MenuV2.Trigger>
          <MenuV2.Portal>
            <MenuV2.Content>
              <MenuV2.Item disabled={blank()} onSelect={() => void navigator.clipboard.writeText(store.url).catch(error => setStore("error", bbError(error)))}>
                {bbt("organization.copyURL")}
              </MenuV2.Item>
              <MenuV2.Item disabled={blank()} onSelect={() => window.api.openExternal(store.url)}>
                {bbt("organization.externalBrowser")}
              </MenuV2.Item>
            </MenuV2.Content>
          </MenuV2.Portal>
        </MenuV2>
        <Show when={store.loading}><span class="bb-browser-loading" role="progressbar" aria-label={bbt("organization.loadingPage")} /></Show>
      </form>
      <Show when={store.error}>
        <div class="bb-browser-error" role="alert"><span>{store.error}</span>
          <button onClick={() => void run("navigate", { url: store.address || address() })}>{bbt("organization.browserRetry")}</button>
        </div>
      </Show>
      <Show when={blank()}>{props.home}</Show>
      <div ref={host} class="bb-browser-host" style={{ display: blank() ? "none" : undefined }} />
    </div>
  )
}
