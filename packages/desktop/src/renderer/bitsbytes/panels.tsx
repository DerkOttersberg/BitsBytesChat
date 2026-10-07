import { createEffect, For, onCleanup, onMount, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import type { DocumentArtifact, SpreadsheetGrid } from "../../bitsbytes/types"
import { bbt, bbError } from "../../bitsbytes/copy"
import { WordPreview } from "./preview"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"

export function DocumentPanel(props: { id: string; revision?: number }) {
  const api = window.api.bitsbytes
  const [store, setStore] = createStore({ artifact: undefined as DocumentArtifact | undefined, bytes: undefined as Uint8Array | undefined, error: "", text: "", image: "", loading: false, mode: "preview", revision: 0, sheet: "", offset: 0, pages: [] as number[], grid: undefined as SpreadsheetGrid | undefined })
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
        const content = await api.call<{ text: string }>("artifact.content", args)
        if (token === generation) setStore({ text: content.text, error: "" })
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
    <Show when={store.error || store.artifact?.error}><div class="bb-preview-error" role="alert"><p>{store.error || bbError(store.artifact?.error)}</p><ButtonV2 variant="ghost-muted" size="normal" onClick={() => void run("artifact.retry")}>{bbt("retryPreview")}</ButtonV2></div></Show>
    <Show when={store.artifact?.kind === "spreadsheet" && store.grid}>{grid => <div class="bb-sheet-panel"><div class="bb-document-toolbar"><select aria-label={bbt("sheet")} value={grid().sheet} disabled={store.loading} onChange={event => { setStore({ sheet: event.currentTarget.value, offset: 0, pages: [], grid: undefined }); refresh() }}><For each={grid().sheets}>{sheet => <option>{sheet}</option>}</For></select><span>{grid().rows.length ? grid().offset + 1 : 0}–{Math.min(grid().total, grid().offset + grid().rows.length)} / {grid().total}</span><ButtonV2 variant="ghost-muted" size="normal" disabled={store.loading || !grid().offset} onClick={() => { setStore("offset", store.pages.at(-1) ?? Math.max(0, grid().offset - 200)); refresh() }}>{bbt("previousRows")}</ButtonV2><ButtonV2 variant="ghost-muted" size="normal" disabled={store.loading || !grid().rows.length || grid().offset + grid().rows.length >= grid().total} onClick={() => { setStore("offset", grid().offset + grid().rows.length); refresh() }}>{bbt("nextRows")}</ButtonV2></div><div class="bb-sheet-scroll"><table><tbody><For each={grid().rows}>{(row, index) => <tr><th>{grid().offset + index() + 1}</th><For each={row}>{(cell, column) => <td title={grid().formulas?.[index()]?.[column()]}>{cell}</td>}</For></tr>}</For></tbody></table></div></div>}</Show>
    <Show when={(store.grid?.columns ?? 0) > 100}><p class="bb-preview-status">{bbt("sheetColumnLimit")}</p></Show>
    <Show when={store.grid?.shortened}><p class="bb-preview-status">{bbt("sheetCellLimit")}</p></Show>
    <Show when={store.artifact?.kind === "html" || store.artifact?.kind === "code"}><Show when={store.artifact?.kind === "html" && store.mode === "preview"} fallback={<pre class="bb-artifact-source">{store.text}</pre>}><Show when={store.text} keyed>{text => { const url = URL.createObjectURL(new Blob([isolatedHTML(text)], { type: "text/html" })); onCleanup(() => URL.revokeObjectURL(url)); return <iframe class="bb-html-preview" title={bbt("htmlPreview")} sandbox="allow-scripts" src={url} /> }}</Show></Show></Show>
    <Show when={store.image}><div class="bb-artifact-image"><img src={store.image} alt={store.artifact?.filename ?? ""} /></div></Show>
    <Show when={["document", "presentation", "pdf"].includes(store.artifact?.kind ?? "document")}><Show when={store.bytes} fallback={<div class="bb-preview-status" role="status"><Show when={store.artifact?.status !== "error"}><i class="bb-preview-spinner" aria-hidden="true" /></Show><p>{bbt(store.artifact?.status === "error" ? "previewFailed" : "previewPreparing")}</p></div>}>{bytes => <WordPreview bytes={bytes()} />}</Show></Show>
  </div>
}

export function BrowserPanel(props: { id: string; active: boolean }) {
  const api = window.api.bitsbytes
  const [store, setStore] = createStore({ url: "", title: "", loading: false, canBack: false, canForward: false, error: "" })
  let host!: HTMLDivElement
  let frame = 0
  let lastBounds = ""
  let generation = 0, disposed = false
  const run = async (action: string, args: Record<string, unknown> = {}) => {
    try { await api.call("browser." + action, { id: props.id, ...args }); setStore("error", "") }
    catch (error) { setStore("error", bbError(error)) }
  }
  function bounds() {
    if (!host) return
    const rect = host.getBoundingClientRect()
    const modal = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"],[role="menu"]')).some(element => !!(element as HTMLElement).offsetParent)
    const args = { bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }, visible: props.active && !modal && rect.width > 0 && rect.height > 0 }
    const key = JSON.stringify(args)
    if (key === lastBounds) return
    lastBounds = key
    void run("bounds", args)
  }
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(bounds) }
  onMount(() => {
    const unsubscribe = api.subscribe(event => { if (event.type === "browser" && event.id === props.id) { generation++; setStore({ url: event.url, title: event.title, loading: event.loading, canBack: event.canBack, canForward: event.canForward }) } })
    const token = generation
    void api.call<{ id: string; url: string; title: string; loading: boolean; canBack: boolean; canForward: boolean }[]>("browser.list").then(items => { if (disposed || token !== generation) return; const item = items.find(item => item.id === props.id); if (item) setStore(item) }).catch(error => { if (!disposed && token === generation) setStore("error", bbError(error)) })
    const resize = new ResizeObserver(schedule); resize.observe(host)
    const observer = new MutationObserver(schedule); observer.observe(document.body, { childList: true, subtree: true })
    window.addEventListener("resize", schedule)
    onCleanup(() => { disposed = true; generation++; unsubscribe(); resize.disconnect(); observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener("resize", schedule); void api.call("browser.hide", { id: props.id }).catch(() => undefined) })
    bounds()
  })
  createEffect(() => { props.active; schedule() })
  return <div class="bb-browser-panel"><form class="bb-browser-toolbar" onSubmit={event => { event.preventDefault(); void run("navigate", { url: store.url }) }}><button type="button" title={bbt("back")} aria-label={bbt("back")} disabled={!store.canBack} onClick={() => void run("back")}>←</button><button type="button" title={bbt("forward")} aria-label={bbt("forward")} disabled={!store.canForward} onClick={() => void run("forward")}>→</button><button type="button" title={bbt(store.loading ? "cancel" : "reload")} aria-label={bbt(store.loading ? "cancel" : "reload")} onClick={() => void run(store.loading ? "stop" : "reload")}>{store.loading ? "×" : "↻"}</button><input aria-label={bbt("address")} value={store.url} onInput={event => { generation++; setStore("url", event.currentTarget.value) }} /><button type="submit" title={bbt("navigate")} aria-label={bbt("navigate")}>↵</button></form><Show when={store.error}><p class="bb-error">{store.error}</p></Show><div ref={host} class="bb-browser-host" /></div>
}
