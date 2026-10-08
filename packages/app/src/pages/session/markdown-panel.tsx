import { Show, createEffect, onCleanup, untrack, type JSX } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { useMarkdownScroll } from "./markdown-scroll"
import { markdownLinkPath } from "./markdown-path"
import "./markdown-panel.css"

export const isMarkdownName = (name: string) => /\.(?:md|markdown|mdown)$/i.test(name)
export type MarkdownResource = { href: string; id?: string }

export function MarkdownPreviewSource(props: {
  identity: string
  text: string
  source: () => JSX.Element
  path?: string
  directory?: string
  sessionID?: string
  artifactID?: string
  revision?: number
  resources?: MarkdownResource[]
}) {
  const language = useLanguage(), platform = usePlatform()
  const [store, setStore] = createStore({ mode: "preview" as "preview" | "source", urls: {} as Record<string, string>, imagesLoading: false, unavailable: false, path: "" })
  let preview!: HTMLDivElement, source!: HTMLDivElement, generation = 0
  useMarkdownScroll(() => props.identity + ":" + (props.revision ?? "working"), { preview: () => preview, source: () => source })
  const revoke = () => untrack(() => Object.values(store.urls).forEach(url => URL.revokeObjectURL(url)))
  createEffect(() => {
    const token = ++generation, id = props.artifactID, revision = props.revision, resources = props.resources ?? []
    const path = props.path, directory = props.directory, sessionID = props.sessionID, text = props.text
    const hasImages = /!\[|<img\b/i.test(text)
    revoke(); setStore("urls", reconcile({}))
    setStore({ imagesLoading: false, unavailable: hasImages, path: "" })
    if (!platform.bitsbytes || !hasImages || text.length > 500_000) return
    type Resource = { href: string; data?: Uint8Array; mime?: string }
    const pending: Promise<{ path?: string; resources: Resource[] }> | undefined = id && resources.length
      ? Promise.all(resources.map(async resource => {
        if (!resource.id) return { href: resource.href }
        try { return { href: resource.href, ...await platform.bitsbytes!.call<{ data: Uint8Array; mime: string }>("artifact.resource", { id, revision, href: resource.href }) } }
        catch { return { href: resource.href } }
      })).then(resources => ({ resources }))
      : !id && path && directory && sessionID
        ? platform.bitsbytes.call("document.resources", { path, directory, sessionID, text })
        : undefined
    if (!pending) return
    setStore({ imagesLoading: true, unavailable: false })
    void pending.then(result => {
      if (token !== generation) return
      const values = result.resources.map(resource => {
        try { return [resource.href, resource.data && resource.mime ? URL.createObjectURL(new Blob([new Uint8Array(resource.data)], { type: resource.mime })) : undefined] as const }
        catch { return [resource.href, undefined] as const }
      })
      setStore("urls", reconcile(Object.fromEntries(values.filter((pair): pair is readonly [string, string] => !!pair[1]))))
      setStore({ imagesLoading: false, unavailable: values.some(([, url]) => !url), path: result.path ?? "" })
    }).catch(() => { if (token === generation) setStore({ imagesLoading: false, unavailable: true }) })
  })
  onCleanup(() => { generation++; revoke() })
  const tooLarge = () => props.text.length > 500_000
  const key = () => `bitsbytes.markdown-view:${props.identity}`
  createEffect(() => {
    const identity = key()
    try { setStore("mode", tooLarge() || localStorage.getItem(identity) === "source" ? "source" : "preview") }
    catch { setStore("mode", tooLarge() ? "source" : "preview") }
  })
  const mode = (value: "preview" | "source") => {
    setStore("mode", value)
    try { localStorage.setItem(key(), value) } catch { /* A view preference must not block the document. */ }
  }
  const link = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest("a[href]") : undefined
    if (!target) return
    const href = target.getAttribute("href") ?? ""
    if (href.startsWith("#")) return
    event.preventDefault()
    if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) { platform.openExternal(href); return }
    if (!props.path) return
    const path = markdownLinkPath(store.path || props.path, props.directory, href)
    if (path) window.dispatchEvent(new CustomEvent("bitsbytes:open-document", { detail: { path, sessionID: props.sessionID } }))
  }
  return <div class="bb-markdown-panel">
    <div class="bb-preview-modes" role="group" aria-label={language.t("bitsbytes.markdown.view")}>
      <button type="button" disabled={tooLarge()} aria-pressed={store.mode === "preview"} onClick={() => mode("preview")}>{language.t("bitsbytes.markdown.preview")}</button>
      <button type="button" aria-pressed={store.mode === "source"} onClick={() => mode("source")}>{language.t("bitsbytes.markdown.source")}</button>
    </div>
    <Show when={tooLarge()}><p class="bb-markdown-limit" role="status">{language.t("bitsbytes.markdown.large")}</p></Show>
    <Show when={store.mode === "preview" && store.imagesLoading}><p class="bb-markdown-limit" role="status">{language.t("common.loading")}</p></Show>
    <Show when={store.mode === "preview" && store.unavailable}><p class="bb-markdown-limit" role="status">{language.t("bitsbytes.markdown.imagesUnavailable")}</p></Show>
    <div ref={preview} class="bb-markdown-preview" hidden={store.mode !== "preview"} onClick={link}>
      <Show when={!tooLarge()}><Markdown text={props.text} cacheKey={props.identity + ":preview"} streaming={false} imageSource={href => store.urls[href]} /></Show>
    </div>
    <div ref={source} class="bb-markdown-source" hidden={store.mode !== "source"}>{props.source()}</div>
  </div>
}

export function MarkdownArtifactPanel(props: { id: string; name: string; revision?: number; path?: string; sessionID?: string }) {
  const platform = usePlatform(), language = useLanguage(), component = useFileComponent()
  const [store, setStore] = createStore({ text: "", loaded: false, error: "", revision: 0, resources: [] as MarkdownResource[] })
  let generation = 0
  const load = async () => {
    const token = ++generation
    try {
      const value = await platform.bitsbytes!.call<{ text: string; revision?: number; resources?: MarkdownResource[] }>("artifact.content", { id: props.id, revision: props.revision || undefined })
      if (token === generation) setStore({ text: value.text, loaded: true, error: "", revision: value.revision ?? props.revision ?? 0, resources: value.resources ?? [] })
    } catch (error) { if (token === generation) setStore("error", String(error)) }
  }
  createEffect(() => { props.id; props.revision; setStore({ loaded: false, text: "", error: "" }); void load() })
  const unsubscribe = platform.bitsbytes!.subscribe(event => {
    if (event.type === "artifact" && (event.artifact as { id: string }).id === props.id) void load()
  })
  onCleanup(() => { generation++; unsubscribe() })
  return <Show when={store.loaded} fallback={<p role="status">{store.error || language.t("common.loading")}</p>}>
    <Show when={store.error}><p role="alert">{store.error}</p></Show>
    <MarkdownPreviewSource identity={props.id} text={store.text} path={props.path} sessionID={props.sessionID} artifactID={props.id} revision={store.revision} resources={store.resources}
      source={() => <Dynamic component={component} mode="text" file={{ name: props.name, contents: store.text }} />} />
  </Show>
}
