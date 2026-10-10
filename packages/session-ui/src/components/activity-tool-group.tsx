import { createMemo, For, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { Icon } from "@opencode-ai/ui/icon"
import { TextShimmer } from "@opencode-ai/ui/text-shimmer"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { activitySummary } from "./activity-presentation"
import "./activity-tool-group.css"

export function ActivityToolGroup(props: {
  parts: ToolPart[]
  pending: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onSizeChange?: () => void
  render: (part: ToolPart) => JSX.Element
}) {
  const i18n = useI18n()
  const [state, setState] = createStore({ open: false })
  const open = () => props.open ?? state.open
  const summary = createMemo(() => activitySummary(props.parts))
  const unfinished = () =>
    !props.pending && props.parts.some((part) => part.state.status === "pending" || part.state.status === "running")
  return (
    <Collapsible
      class="bb-tool-activity"
      variant="ghost"
      open={open()}
      data-timeline-part-ids={props.parts.map((part) => part.id).join(",")}
      onOpenChange={(value) => {
        if (props.open === undefined) setState("open", value)
        props.onOpenChange?.(value)
        requestAnimationFrame(() => props.onSizeChange?.())
      }}
    >
      <Collapsible.Trigger title={i18n.t("ui.activity.count", { count: props.parts.length })}>
        <Icon name={summary().icon} size="small" />
        <TextShimmer text={i18n.t(summary().key)} active={props.pending} />
        <Show when={unfinished()}>
          <span data-slot="activity-interrupted">{i18n.t("ui.message.interrupted")}</span>
        </Show>
        <Collapsible.Arrow />
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div
          data-slot="activity-list"
          data-scrollable
          tabIndex={0}
          role="region"
          aria-label={i18n.t("ui.activity.count", { count: props.parts.length })}
        >
          <For each={props.parts}>{(part) => <div data-slot="activity-item">{props.render(part)}</div>}</For>
        </div>
      </Collapsible.Content>
    </Collapsible>
  )
}
