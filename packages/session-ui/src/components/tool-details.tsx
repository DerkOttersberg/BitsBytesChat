import { createMemo, createSignal, Show } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"

/** Details mount only after expansion; long diagnostics stay bounded visually. */
export function ToolDetails(props: { tool: string; input?: unknown; output?: string; error?: string }) {
  const i18n = useI18n()
  const [limit, setLimit] = createSignal(65_536)
  const argumentsText = createMemo(() => JSON.stringify(props.input ?? {}, null, 2))
  const copy = (value: string) => void navigator.clipboard?.writeText(value).catch(() => undefined)
  return (
    <div data-component="tool-raw-details" class="min-w-0 flex flex-col gap-2 p-3 text-12-regular">
      <div>
        <strong>{i18n.t("ui.tool.rawName")}</strong>: <code>{props.tool}</code>
      </div>
      <div>
        <strong>{i18n.t("ui.tool.arguments")}</strong>
        <pre class="max-h-80 overflow-auto whitespace-pre-wrap break-all">{argumentsText()?.slice(0, limit())}</pre>
        <Show when={(argumentsText()?.length ?? 0) > limit()}>
          <button type="button" onClick={() => setLimit((value) => value + 65_536)}>
            {i18n.t("ui.common.showMore")}
          </button>
        </Show>
        <button type="button" onClick={() => copy(argumentsText() ?? "")}>
          {i18n.t("ui.message.copy")}
        </button>
      </div>
      <Show when={props.output || props.error}>
        {(value) => (
          <div>
            <strong>{i18n.t(props.error ? "ui.toolErrorCard.failed" : "ui.tool.output")}</strong>
            <pre class="max-h-80 overflow-auto whitespace-pre-wrap break-all">{value().slice(0, limit())}</pre>
            <Show when={value().length > limit()}>
              <button type="button" onClick={() => setLimit((value) => value + 65_536)}>
                {i18n.t("ui.common.showMore")}
              </button>
            </Show>
            <button type="button" onClick={() => copy(value())}>
              {i18n.t("ui.message.copy")}
            </button>
          </div>
        )}
      </Show>
    </div>
  )
}
