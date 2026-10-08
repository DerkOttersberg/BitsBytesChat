import { Show, createEffect, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import "./markdown-panel.css"

export function RecordedImagePanel(props: { id: string; name: string; sessionID: string }) {
  const platform = usePlatform(), language = useLanguage()
  const [store, setStore] = createStore({ url: "", width: 0, height: 0, error: "" })
  let generation = 0
  createEffect(() => {
    const id = props.id, sessionID = props.sessionID, token = ++generation
    untrack(() => { if (store.url) URL.revokeObjectURL(store.url) })
    setStore({ url: "", width: 0, height: 0, error: "" })
    void platform.bitsbytes!.call<{ data: Uint8Array; mime: string; width: number; height: number }>("image.read", { id, sessionID }).then(value => {
      if (token !== generation) return
      if (store.url) URL.revokeObjectURL(store.url)
      setStore({ url: URL.createObjectURL(new Blob([new Uint8Array(value.data)], { type: value.mime })), width: value.width, height: value.height, error: "" })
    }).catch(() => { if (token === generation) setStore("error", language.t("bitsbytes.imageRead.unavailable")) })
  })
  onCleanup(() => { generation++; if (store.url) URL.revokeObjectURL(store.url) })
  return <div class="bb-recorded-image-panel">
    <Show when={store.error}><p role="alert" class="bb-recorded-image-meta">{store.error}</p></Show>
    <Show when={store.url} fallback={<Show when={!store.error}><p role="status" class="bb-recorded-image-meta">{language.t("common.loading")}</p></Show>}>
      <div class="bb-recorded-image-meta">{language.t("bitsbytes.imageRead.dimensions", { width: store.width, height: store.height })}</div>
      <div class="bb-recorded-image-canvas"><img src={store.url} alt={props.name} /></div>
    </Show>
  </div>
}
