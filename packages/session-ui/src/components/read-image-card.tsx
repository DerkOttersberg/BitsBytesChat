import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import type { RecordedReadImage } from "./read-tool-images"
import "./read-image-card.css"

export function ReadImageCard(props: {
  images: readonly RecordedReadImage[]
  sessionID?: string
  messageID?: string
  partID?: string
  filename?: string
  onContentRendered?: () => void
}) {
  const i18n = useI18n()
  return <Show when={props.images.length}><div data-component="recorded-image-cards">
    <For each={props.images}>{image => {
      const [size, setSize] = createStore({ width: 0, height: 0 })
      const filename = () => (image.filename || props.filename || i18n.t("ui.imagePreview.alt")).split(/[\\/]/).at(-1)!
      return <div data-slot="recorded-image-card">
        <img src={image.url} alt={filename()} loading="lazy" onLoad={event => {
          setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
          props.onContentRendered?.()
        }} />
        <div data-slot="recorded-image-description"><span title={filename()}>{filename()}</span>
          <Show when={size.width && size.height}><span data-slot="recorded-image-dimensions">{i18n.t("ui.imageRead.dimensions", { width: size.width, height: size.height })}</span></Show>
        </div>
        <button type="button" disabled={!props.sessionID || !props.messageID || !props.partID}
          onClick={() => window.dispatchEvent(new CustomEvent("bitsbytes:open-recorded-image", { detail: {
            sessionID: props.sessionID, messageID: props.messageID, partID: props.partID,
            attachmentIndex: image.attachmentIndex, url: image.url, mime: image.mime, filename: filename(),
          } }))}>{i18n.t("ui.imageRead.open")}</button>
      </div>
    }}</For>
  </div></Show>
}
