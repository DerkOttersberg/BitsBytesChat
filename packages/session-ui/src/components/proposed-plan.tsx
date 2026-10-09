import { createMemo, Show } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { Markdown } from "./markdown"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { proposedPlan } from "@opencode-ai/core/util/proposed-plan"
import "./proposed-plan.css"
export { proposedPlan } from "@opencode-ai/core/util/proposed-plan"

export function ProposedPlan(props: { text: string; sessionID: string; streaming: boolean }) {
  const i18n = useI18n(),
    value = createMemo(() => proposedPlan(props.text))
  const excerpt = createMemo(() => value()?.plan.slice(0, 1000).split("\n").slice(0, 10).join("\n") ?? "")
  const publish = (implement = false) =>
    window.dispatchEvent(
      new CustomEvent("bitsbytes:plan-proposal", {
        detail: { sessionID: props.sessionID, text: value()?.plan, implement },
      }),
    )
  const download = () => {
    const link = document.createElement("a")
    link.href = URL.createObjectURL(new Blob([value()?.plan ?? ""], { type: "text/markdown" }))
    link.download = "plan.md"
    link.click()
    setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  }
  return (
    <Show when={value()}>
      {(plan) => (
        <>
          <Show when={plan().before.trim()}>
            <Markdown text={plan().before} />
          </Show>
          <section class="bb-proposed-plan" data-component="proposed-plan">
            <div class="bb-proposed-plan-heading">{i18n.t(props.streaming ? "ui.plan.writing" : "ui.plan.title")}</div>
            <div class="bb-proposed-plan-body" data-truncated={excerpt().length < plan().plan.length}>
              <Markdown text={excerpt()} />
            </div>
            <div class="bb-proposed-plan-actions">
              <ButtonV2 size="normal" variant="ghost-muted" onClick={download}>
                {i18n.t("ui.plan.export")}
              </ButtonV2>
              <ButtonV2 size="normal" variant="ghost-muted" disabled={!plan().complete} onClick={() => publish()}>
                <Icon name="expand" />
                {i18n.t("ui.plan.open")}
              </ButtonV2>
              <ButtonV2
                size="normal"
                variant="ghost"
                class="bb-plan-implement"
                disabled={props.streaming || !plan().complete}
                onClick={() => publish(true)}
              >
                <Icon name="arrow-right" />
                {i18n.t("ui.plan.implement")}
              </ButtonV2>
            </div>
          </section>
          <Show when={plan().after.trim()}>
            <Markdown text={plan().after} />
          </Show>
        </>
      )}
    </Show>
  )
}
