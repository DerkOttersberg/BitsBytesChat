import { createEffect, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode-ai/ui/icon"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { ImageGenerationGallery } from "./image-generation-card"

type Item = { id: string; sessionID: string; turnID?: string; turnIDs?: string[]; filename: string; revision: number; kind?: string; status: string; path: string; history?: { revision: number; turnID?: string }[] }
export function ArtifactCards(props: { sessionID: string; messageIDs: string[]; inputIDs: string[]; tools: ToolPart[] }) {
  const i18n = useI18n()
  const [store, setStore] = createStore({ items: [] as Item[] })
  const owners = () => [...props.messageIDs, ...props.inputIDs]
  const receive = (items: Item[]) => setStore("items", items.filter(item => item.sessionID === props.sessionID && (item.turnIDs ?? (item.turnID ? [item.turnID] : [])).some(id => owners().includes(id))).map(item => ({ ...item, revision: item.history?.findLast(version => version.turnID && owners().includes(version.turnID))?.revision ?? item.revision })))
  createEffect(() => { props.messageIDs; window.dispatchEvent(new CustomEvent("bitsbytes:artifact-query", { detail: { receive } })) })
  const update = (event: Event) => receive((event as CustomEvent<Item[]>).detail)
  window.addEventListener("bitsbytes:artifact-change", update)
  onCleanup(() => window.removeEventListener("bitsbytes:artifact-change", update))
  return <><ImageGenerationGallery sessionID={props.sessionID} inputIDs={props.inputIDs} tools={props.tools} artifacts={store.items.filter(item => item.kind === "image")} /><Show when={store.items.some(item => item.kind !== "image")}><div class="bb-artifact-cards" data-component="artifact-cards"><For each={store.items.filter(item => item.kind !== "image")}>{item => <button class="bb-artifact-card" onClick={() => window.dispatchEvent(new CustomEvent("bitsbytes:open-artifact", { detail: { id: item.id, sessionID: item.sessionID, revision: item.revision } }))} title={item.path}>
    <Icon name={item.kind === "code" || item.kind === "html" ? "code" : "open-file"} /><span><strong>{item.filename}</strong><small>{i18n.t("ui.artifact.revision", { revision: item.revision })}<Show when={item.status !== "ready"}> · {i18n.t(item.status === "error" ? "ui.artifact.error" : "ui.artifact.preparing")}</Show></small></span><Icon name="open-file" />
  </button>}</For></div></Show></>
}
