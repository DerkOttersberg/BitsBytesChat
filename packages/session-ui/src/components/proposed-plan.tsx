import { createMemo, Show } from "solid-js"
import { createStore } from "solid-js/store"
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
  const [store, setStore] = createStore({ expanded: false })
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
          <details
            class="bb-proposed-plan"
            open={props.streaming}
            data-component="proposed-plan"
            onToggle={(event) => {
              if (!event.currentTarget.open) setStore("expanded", false)
            }}
          >
            <summary>
              {i18n.t(props.streaming ? "ui.plan.writing" : "ui.plan.title")}
              <Icon name="chevron-down" class="bb-plan-chevron" />
            </summary>
            <div class="bb-proposed-plan-body" data-expanded={store.expanded}>
              <Markdown text={plan().plan} />
            </div>
            <div class="bb-proposed-plan-actions">
              <ButtonV2
                size="normal"
                variant="ghost-muted"
                aria-expanded={store.expanded}
                onClick={() => setStore("expanded", (value) => !value)}
              >
                {i18n.t(store.expanded ? "ui.plan.collapse" : "ui.plan.expand")}
              </ButtonV2>
              <ButtonV2 size="normal" variant="ghost-muted" onClick={download}>
                {i18n.t("ui.plan.export")}
              </ButtonV2>
              <ButtonV2 size="normal" variant="ghost-muted" disabled={!plan().complete} onClick={() => publish()}>
                {i18n.t("ui.plan.open")}
              </ButtonV2>
              <ButtonV2
                size="normal"
                variant="contrast"
                disabled={props.streaming || !plan().complete}
                onClick={() => publish(true)}
              >
                {i18n.t("ui.plan.implement")}
              </ButtonV2>
            </div>
          </details>
          <Show when={plan().after.trim()}>
            <Markdown text={plan().after} />
          </Show>
        </>
      )}
    </Show>
  )
}
