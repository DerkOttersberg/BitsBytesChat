import { createEffect, For, onCleanup, Show } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { useParams, useSearchParams } from "@solidjs/router"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { usePlatform } from "../context/platform"
import { useLanguage } from "../context/language"
import { useSDK } from "../context/sdk"
import { usePrompt } from "../context/prompt"
import { useLocal } from "../context/local"
import { draftAccessKey } from "./chat-access"
import type { FollowupDraft } from "./prompt-input/submit"
import { createLegacyBlobReference } from "../utils/draft-store"
import "./chat-runs.css"

export type RunState = {
  sessionID: string; mode: "normal" | "plan"; goalDraft: boolean; paused: boolean; error: string
  queue: { id: string; status: string; editing?: boolean; error?: string; prompt: { draft?: FollowupDraft; text: string } }[]
  goal?: { objective: string; status: string; reason: string; evidence: string; tokens: number; elapsed: number; started: number; budget?: number }
  plan?: { id: string; revision: number; text: string; versions: { revision: number; text: string }[] }
}

export function useChatRun() {
  const platform = usePlatform(), sdk = useSDK(), params = useParams(), language = useLanguage()
  const [search] = useSearchParams<{ draftId?: string }>()
  const [store, setStore] = createStore<{ value?: RunState; error: string }>({ error: "" })
  const identity = () => params.id ?? draftAccessKey(sdk().scope, sdk().directory, search.draftId)
  const refresh = async () => {
    const sessionID = identity()
    const value = await platform.bitsbytes?.call<RunState>("runs.get", { sessionID })
    if (sessionID === identity()) setStore("value", value)
  }
  createEffect(() => { identity(); void refresh().catch(error => setStore("error", String(error))) })
  const unsubscribe = platform.bitsbytes?.subscribe(event => { if (event.type === "run" && event.sessionID === identity()) void refresh() })
  onCleanup(() => unsubscribe?.())
  const call = async (action: string, args: Record<string, unknown> = {}) => {
    try { await platform.bitsbytes?.call("runs." + action, { sessionID: identity(), ...args }); await refresh(); setStore("error", "") }
    catch (error) { setStore("error", String(error).includes("bb.error.goalBudget") ? language.t("bitsbytes.goalBudgetReached") : String(error)); throw error }
  }
  return { store, call, identity }
}

export function ModeIcon(props: { kind: "plan" | "goal" | "steer" }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <Show when={props.kind === "plan"}><path d="M9 18h6m-5 3h4M8.6 14.8A6 6 0 1 1 15.4 14.8L15 17H9z" /></Show>
    <Show when={props.kind === "goal"}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></Show>
    <Show when={props.kind === "steer"}><path d="M5 20V11a5 5 0 0 1 5-5h10m-5-4 5 4-5 4" /></Show>
  </svg>
}

export function ChatRuns() {
  const run = useChatRun(), language = useLanguage(), prompt = usePrompt(), local = useLocal(), sdk = useSDK(), platform = usePlatform()
  const [store, setStore] = createStore({ confirmGoal: false, editing: "", prior: undefined as FollowupDraft | undefined, now: Date.now() })
  const timer = setInterval(() => { if (run.store.value?.goal?.status === "active") setStore("now", Date.now()) }, 1000)
  onCleanup(() => clearInterval(timer))
  const action = (name: string, args: Record<string, unknown> = {}) => void run.call(name, args).catch(() => undefined)
  const open = (kind: "plan" | "goal") => window.dispatchEvent(new CustomEvent("bitsbytes:run-panel", { detail: { kind, sessionID: run.identity() } }))
  const title = (item: RunState["queue"][number]) => item.prompt.draft?.prompt.map(part => "content" in part ? part.content : `[${part.filename}]`).join("").trim() || item.prompt.text
  async function edit(item: RunState["queue"][number]) {
    if (!item.prompt.draft) return
    await run.call("edit", { id: item.id })
    const model = local.model.current()
    setStore({ editing: item.id, prior: model ? structuredClone(unwrap({ sessionID: run.identity(), sessionDirectory: sdk().directory, prompt: prompt.current(), context: prompt.context.items(), agent: local.agent.current()?.name ?? "build", model: { providerID: model.provider.id, modelID: model.id }, variant: local.model.variant.current() })) : undefined })
    const parts = await Promise.all(item.prompt.draft.prompt.map(async part => {
      if (part.type !== "image") return part
      const image = part as typeof part & { dataUrl?: string }
      return { ...part, blob: image.dataUrl ? createLegacyBlobReference(image.dataUrl) : part.blob }
    }))
    prompt.set(parts)
    for (const context of prompt.context.items()) prompt.context.remove(context.key)
    for (const context of item.prompt.draft.context) prompt.context.add(context)
    local.agent.set(item.prompt.draft.agent)
    local.model.set({ providerID: item.prompt.draft.model.providerID, modelID: item.prompt.draft.model.modelID })
    local.model.variant.set(item.prompt.draft.variant)
  }
  createEffect(() => { if (store.editing && !run.store.value?.queue.some(item => item.id === store.editing && item.editing)) setStore({ editing: "", prior: undefined }) })
  const goalRequest = (event: Event) => { if ((event as CustomEvent).detail.sessionID !== run.identity()) return; if (run.store.value?.goal && run.store.value.goal.status !== "complete") setStore("confirmGoal", true); else action("goal-draft", { enabled: true }) }
  window.addEventListener("bitsbytes:goal-draft", goalRequest)
  onCleanup(() => window.removeEventListener("bitsbytes:goal-draft", goalRequest))
  return <Show when={platform.bitsbytes}><div class="bb-run-controls">
    <Show when={run.store.value?.queue.length}>
      <div class="bb-run-queue" data-component="durable-queue">
        <div class="bb-run-heading"><span>{language.t("bitsbytes.queued", { count: run.store.value?.queue.length ?? 0 })}</span>
          <Show when={run.store.value?.paused}><ButtonV2 size="normal" variant="ghost-muted" onClick={() => action("resume")}>{language.t("bitsbytes.resumeQueue")}</ButtonV2></Show>
        </div>
        <For each={run.store.value?.queue}>{(item, index) => <div class="bb-queue-row">
          <span class="bb-queue-text" title={title(item)}>{title(item)}</span>
          <Show when={item.error}><span class="bb-queue-error" title={item.error}>{language.t("bitsbytes.deliveryUncertain")}</span></Show>
          <button disabled={item.status === "sending"} title={language.t(item.error ? "bitsbytes.retry" : "bitsbytes.steer")} aria-label={language.t(item.error ? "bitsbytes.retry" : "bitsbytes.steer")} onClick={() => action(item.error ? "retry" : "steer", { id: item.id })}><ModeIcon kind="steer" /></button>
          <MenuV2 placement="top-end"><MenuV2.Trigger as={ButtonV2} size="normal" variant="ghost-muted" aria-label={language.t("bitsbytes.queueActions")} disabled={item.status === "sending"}><span aria-hidden="true">⋯</span></MenuV2.Trigger><MenuV2.Portal><MenuV2.Content>
            <MenuV2.Item onSelect={() => void edit(item)}>{language.t("bitsbytes.edit")}</MenuV2.Item>
            <MenuV2.Item disabled={!index()} onSelect={() => { const ids = run.store.value!.queue.map(row => row.id); [ids[index() - 1], ids[index()]] = [ids[index()], ids[index() - 1]]; action("reorder", { ids }) }}>{language.t("bitsbytes.moveUp")}</MenuV2.Item>
            <MenuV2.Item disabled={index() === (run.store.value?.queue.length ?? 0) - 1} onSelect={() => { const ids = run.store.value!.queue.map(row => row.id); [ids[index() + 1], ids[index()]] = [ids[index()], ids[index() + 1]]; action("reorder", { ids }) }}>{language.t("bitsbytes.moveDown")}</MenuV2.Item>
            <MenuV2.Item onSelect={() => window.dispatchEvent(new CustomEvent("bitsbytes:side-chat", { detail: { source: run.identity(), directory: sdk().directory, draft: item.prompt.draft, variant: local.model.variant.current() ?? null } }))}>{language.t("bitsbytes.sideChat")}</MenuV2.Item>
          </MenuV2.Content></MenuV2.Portal></MenuV2>
          <button disabled={item.status === "sending"} title={language.t("bitsbytes.delete")} aria-label={language.t("bitsbytes.delete")} onClick={() => action("delete", { id: item.id })}><Icon name="close-small" /></button>
        </div>}</For>
        <Show when={store.editing}><div class="bb-run-heading"><span>{language.t("bitsbytes.editingQueued")}</span><ButtonV2 size="normal" variant="ghost-muted" onClick={() => { action("cancel-edit", { id: store.editing }); if (store.prior) { prompt.set(store.prior.prompt); for (const context of prompt.context.items()) prompt.context.remove(context.key); for (const context of store.prior.context) prompt.context.add(context); local.agent.set(store.prior.agent); local.model.set(store.prior.model); local.model.variant.set(store.prior.variant) } setStore({ editing: "", prior: undefined }) }}>{language.t("bitsbytes.cancelEdit")}</ButtonV2></div></Show>
      </div>
    </Show>
    <Show when={run.store.value?.goal}>{goal => <div class="bb-goal-row" data-status={goal().status}>
      <button class="bb-goal-summary" onClick={() => open("goal")} title={goal().objective}><ModeIcon kind="goal" /><span>{language.t((`bitsbytes.goal.${goal().status}`) as "bitsbytes.goal.active")}</span><span class="bb-goal-objective">{goal().objective}</span></button>
      <span class="bb-goal-stat">{goal().budget ? language.t("bitsbytes.goalTokens", { tokens: goal().tokens, budget: goal().budget! }) : language.t("bitsbytes.goalElapsed", { minutes: Math.floor((goal().status === "active" ? Math.max(0, store.now - goal().started) : goal().elapsed) / 60000) })}</span>
      <Show when={goal().status !== "complete"}><ButtonV2 size="normal" variant="ghost-muted" onClick={() => action(goal().status === "active" ? "goal-pause" : "goal-resume")}>{language.t(goal().status === "active" ? "bitsbytes.pause" : "bitsbytes.resume")}</ButtonV2></Show>
      <MenuV2 placement="top-end"><MenuV2.Trigger as={ButtonV2} size="normal" variant="ghost-muted" aria-label={language.t("bitsbytes.goalActions")}><span aria-hidden="true">⋯</span></MenuV2.Trigger><MenuV2.Portal><MenuV2.Content><MenuV2.Item onSelect={() => open("goal")}>{language.t("bitsbytes.edit")}</MenuV2.Item><MenuV2.Item onSelect={() => action("goal-clear")}>{language.t("bitsbytes.clearGoal")}</MenuV2.Item></MenuV2.Content></MenuV2.Portal></MenuV2>
    </div>}</Show>
    <div class="bb-mode-row">
      <Show when={run.store.value?.mode === "plan"}><button class="bb-mode-chip" onClick={() => { action("mode", { mode: "normal" }); local.agent.set("build") }} title={language.t("bitsbytes.removePlan")}><ModeIcon kind="plan" />{language.t("bitsbytes.plan")}<Icon name="close-small" /></button></Show>
      <Show when={run.store.value?.goalDraft}><button class="bb-mode-chip" onClick={() => action("goal-draft", { enabled: false })} title={language.t("bitsbytes.removeGoal")}><ModeIcon kind="goal" />{language.t("bitsbytes.goal")}<Icon name="close-small" /></button></Show>
      <Show when={run.store.value?.plan}><ButtonV2 size="normal" variant="ghost-muted" onClick={() => open("plan")}><ModeIcon kind="plan" />{language.t("bitsbytes.openPlan")}</ButtonV2></Show>
    </div>
    <Show when={run.store.error}><p class="bb-queue-error" role="alert">{run.store.error}</p></Show>
    <Show when={store.confirmGoal}><div class="bb-run-heading"><span>{language.t("bitsbytes.replaceGoal")}</span><ButtonV2 size="normal" variant="ghost-muted" onClick={() => setStore("confirmGoal", false)}>{language.t("bitsbytes.cancel")}</ButtonV2><ButtonV2 size="normal" variant="contrast" onClick={() => { action("goal-draft", { enabled: true, replace: true }); setStore("confirmGoal", false) }}>{language.t("bitsbytes.replace")}</ButtonV2></div></Show>
  </div></Show>
}
