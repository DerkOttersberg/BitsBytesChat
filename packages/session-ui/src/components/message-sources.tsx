import { For, Show } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { recordedSources, type RecordedSource } from "./message-source"

export function MessageSources(props: { metadata?: Record<string, unknown>; sessionID: string }) {
  const i18n = useI18n()
  const sources = () => recordedSources(props.metadata)
  const title = (source: RecordedSource) =>
    source.title || source.filename || (source.url ? new URL(source.url).hostname : i18n.t("ui.message.sources"))
  return (
    <Show when={sources().length}>
      <div data-component="message-sources">
        <For each={sources()}>
          {(source, index) => (
            <button
              class="source-pill"
              title={source.url || source.filename || source.id}
              disabled={!source.url}
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("bitsbytes:source", { detail: { sessionID: props.sessionID, url: source.url } }),
                )
              }
            >
              <span>{index() + 1}</span>
              {title(source)}
            </button>
          )}
        </For>
        <details>
          <summary>{i18n.t("ui.message.sources")}</summary>
          <ol>
            <For each={sources()}>
              {(source) => (
                <li>
                  <strong>{title(source)}</strong>
                  <p>{source.url || source.filename || source.id}</p>
                </li>
              )}
            </For>
          </ol>
        </details>
      </div>
    </Show>
  )
}
