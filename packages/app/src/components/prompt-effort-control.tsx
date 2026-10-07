import { Popover } from "@kobalte/core/popover"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { createMemo, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import type { PromptInputProps } from "./prompt-input/contracts"
import "./prompt-effort-control.css"

const LABELS = {
  default: "prompt.effort.default", none: "prompt.effort.none", minimal: "prompt.effort.minimal",
  low: "prompt.effort.low", medium: "prompt.effort.medium", high: "prompt.effort.high",
  xhigh: "prompt.effort.xhigh", max: "prompt.effort.max",
} as const

export function PromptEffortControl(props: {
  selection: PromptInputProps["controls"]["model"]["selection"]
  onClose: () => void
}) {
  const language = useLanguage()
  const efforts = createMemo(() => props.selection.variant.list())
  const current = () => props.selection.variant.current() ?? "default"
  const label = (value: string) => value in LABELS ? language.t(LABELS[value as keyof typeof LABELS]) : value
  const position = () => {
    const value = current() === "default" ? props.selection.current()?.options.reasoningEffort : current()
    const index = typeof value === "string" ? efforts().indexOf(value) : -1
    return index >= 0 ? index : Math.floor((efforts().length - 1) / 2)
  }
  const select = (value: string) => props.selection.variant.set(value === "default" ? undefined : value)

  return (
    <Popover placement="top-start" gutter={6}>
      <Popover.Trigger as={ButtonV2} variant="ghost-muted" size="normal"
        data-action="prompt-effort" class="min-w-0 ![font-weight:440]" style={{ height: "28px" }}
        aria-label={language.t("prompt.effort.choose")} title={language.t("prompt.effort.current", { effort: label(current()) })}>
        <Icon name="outline-sliders" />
        <span class="truncate">{current() === "default" ? language.t("prompt.effort.defaultShort") : label(current())}</span>
        <Icon name="chevron-down" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content data-component="prompt-effort" onCloseAutoFocus={(event) => {
          event.preventDefault()
          props.onClose()
        }}>
          <div class="effort-heading">
            <div>
              <Popover.Title>{language.t("prompt.effort.title")}</Popover.Title>
              <div class="effort-value">{label(current())}</div>
            </div>
            <IconButtonV2 icon={<Icon name="outline-reset" />} variant="ghost-muted" size="normal"
              aria-label={language.t("prompt.effort.reset")} disabled={current() === "default"}
              onClick={() => select("default")} />
          </div>
          <Popover.Description class="effort-description">
            {language.t(efforts().length ? "prompt.effort.description" : "prompt.effort.unsupported")}
          </Popover.Description>
          <Show when={efforts().length}>
            <Show when={efforts().length > 1}>
              <input type="range" min="0" max={efforts().length - 1} step="1" value={position()}
                aria-label={language.t("prompt.effort.choose")}
                aria-valuetext={label(efforts()[position()])}
                onInput={(event) => select(efforts()[Number(event.currentTarget.value)])} />
              <div class="effort-endpoints" aria-hidden="true">
                <span>{label(efforts()[0])}</span><span>{label(efforts()[efforts().length - 1])}</span>
              </div>
            </Show>
            <select aria-label={language.t("prompt.effort.choose")} value={current()}
              onChange={(event) => select(event.currentTarget.value)}>
              <option value="default">{label("default")}</option>
              <For each={efforts()}>{(effort) => <option value={effort}>{label(effort)}</option>}</For>
            </select>
          </Show>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  )
}
