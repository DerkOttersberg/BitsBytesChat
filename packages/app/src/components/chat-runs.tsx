import { createEffect, createMemo, For, onCleanup, Show } from "solid-js"
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
import { readQueuedDraft, restoreQueuedDraft } from "./chat-run-draft"
import { createQueuedEditGuard, moveQueuedInput, queuedEditCancelAction, queuedEditSelection, type QueuedEditComposer, type QueuedEditPrior } from "./chat-run-controls"
import "./chat-runs.css"

export type RunState = {
  sessionID: string; mode: "normal" | "plan"; goalDraft: boolean; paused: boolean; error: string
  queue: { id: string; status: string; editing?: boolean; error?: string; prompt: { draft?: FollowupDraft; text: string } }[]
  goal?: { objective: string; status: string; reason: string; evidence: string; tokens: number; elapsed: number; started: number; budget?: number; summaryDismissed?: boolean }
  plan?: { id: string; revision: number; text: string; versions: { revision: number; text: string }[] }
}

export function useChatRun() {
  const platform = usePlatform(), sdk = useSDK(), params = useParams(), language = useLanguage()
  const [search] = useSearchParams<{ draftId?: string }>()
  const [store, setStore] = createStore<{ value?: RunState; error: string }>({ error: "" })
  const identity = () => params.id ?? draftAccessKey(sdk().scope, sdk().directory, search.draftId)
  let generation = 0, disposed = false, selected = ""
  const refresh = async () => {
    const sessionID = identity(), request = ++generation
    if (selected !== sessionID) { selected = sessionID; setStore({ value: undefined, error: "" }) }
    try {
      const value = await platform.bitsbytes?.call<RunState>("runs.get", { sessionID })
      if (!disposed && request === generation && sessionID === identity()) setStore({ value, error: "" })
    } catch (error) {
      if (!disposed && request === generation && sessionID === identity()) setStore("error", String(error))
    }
  }
  createEffect(() => { identity(); void refresh() })
  const unsubscribe = platform.bitsbytes?.subscribe(event => { if (event.type === "run" && event.sessionID === identity()) void refresh() })
  onCleanup(() => { disposed = true; generation++; unsubscribe?.() })
  const call = async (action: string, args: Record<string, unknown> = {}) => {
    const sessionID = identity()
    try { await platform.bitsbytes?.call("runs." + action, { sessionID, ...args }); await refresh() }
    catch (error) { if (!disposed && sessionID === identity()) setStore("error", String(error).includes("bb.error.goalBudget") ? language.t("bitsbytes.goalBudgetReached") : String(error)); throw error }
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
  const [store, setStore] = createStore({ confirmGoal: false, editing: "", prior: undefined as QueuedEditPrior | undefined, now: Date.now() })
  const queued = createMemo(() => run.store.value?.queue.filter(item => !item.editing) ?? [])
  const editing = createMemo(() => run.store.value?.queue.find(item => item.editing)?.id ?? "")
  const editGuard = createQueuedEditGuard()
  createEffect(() => { if (editGuard.select(run.identity())) setStore({ editing: "", prior: undefined }) })
  onCleanup(editGuard.invalidate)
  const timer = setInterval(() => { if (run.store.value?.goal?.status === "active") setStore("now", Date.now()) }, 1000)
  onCleanup(() => clearInterval(timer))
  const action = (name: string, args: Record<string, unknown> = {}) => void run.call(name, args).catch(() => undefined)
  const move = (id: string, step: -1 | 1) => { const ids = moveQueuedInput(run.store.value?.queue ?? [], id, step); if (ids) action("reorder", { ids }) }
  const open = (kind: "plan" | "goal") => window.dispatchEvent(new CustomEvent("bitsbytes:run-panel", { detail: { kind, sessionID: run.identity() } }))
  const title = (item: RunState["queue"][number]) => readQueuedDraft(item.prompt.draft)?.prompt.map(part => "content" in part ? part.content : `[${part.filename}]`).join("").trim() || item.prompt.text
  const captureComposer = (): QueuedEditComposer => {
    const model = local.model.current(), selection = local.session.selection()
    return structuredClone(unwrap({ prompt: prompt.current(), context: prompt.context.items(), ...queuedEditSelection({ selectedAgent: selection?.agent, resolvedAgent: local.agent.current()?.name, selectedModel: selection?.model, resolvedModel: model ? { providerID: model.provider.id, modelID: model.id } : undefined, selectedVariant: selection?.variant, resolvedVariant: local.model.variant.current() }) }))
  }
  async function edit(item: RunState["queue"][number]) {
    const draft = readQueuedDraft(item.prompt.draft)
    if (!draft) return
    const sessionID = run.identity(), prior = store.prior?.sessionID === sessionID ? store.prior : undefined, request = editGuard.begin(sessionID)
    await Promise.all([local.session.ready.promise, prompt.ready.promise])
    if (!editGuard.current(request, run.identity())) return
    await run.call("edit", { id: item.id })
    if (!editGuard.current(request, run.identity()) || !run.store.value?.queue.some(row => row.id === item.id && row.editing)) return
    setStore({ editing: item.id, prior: prior ?? { sessionID, ...captureComposer() } })
    prompt.set(restoreQueuedDraft(draft).prompt)
    for (const context of prompt.context.items()) prompt.context.remove(context.key)
    for (const context of draft.context) prompt.context.add(context)
    local.agent.set(draft.agent)
    local.model.set({ providerID: draft.model.providerID, modelID: draft.model.modelID })
    local.model.variant.set(draft.variant)
  }
  async function cancelEdit() {
    if (!editing()) return
    const sessionID = run.identity(), id = editing(), request = editGuard.begin(sessionID)
    await Promise.all([local.session.ready.promise, prompt.ready.promise])
    if (!editGuard.current(request, run.identity()) || editing() !== id) return
    const prior = store.prior?.sessionID === sessionID ? store.prior : undefined, before = captureComposer()
    const queued = readQueuedDraft(run.store.value?.queue.find(row => row.id === id)?.prompt.draft)
    await run.call("cancel-edit", { id })
    if (!editGuard.current(request, run.identity())) return
    const policy = queuedEditCancelAction({ sessionID, prior, queued, before, current: captureComposer() })
    if (policy === "restore" && prior) {
      prompt.set([...prior.prompt])
      for (const context of prompt.context.items()) prompt.context.remove(context.key)
      for (const context of prior.context) prompt.context.add(context)
      local.agent.set(prior.agent)
      local.model.set(prior.model)
      local.model.variant.set(prior.variant)
    }
    if (policy === "clear") {
      prompt.reset()
      for (const context of prompt.context.items()) prompt.context.remove(context.key)
    }
    setStore({ editing: "", prior: undefined })
  }
  createEffect(() => { if (store.editing && !run.store.value?.queue.some(item => item.id === store.editing && item.editing)) setStore({ editing: "", prior: undefined }) })
  const goalRequest = (event: Event) => { if ((event as CustomEvent).detail.sessionID !== run.identity()) return; if (run.store.value?.goal && run.store.value.goal.status !== "complete") setStore("confirmGoal", true); else action("goal-draft", { enabled: true }) }
  window.addEventListener("bitsbytes:goal-draft", goalRequest)
  onCleanup(() => window.removeEventListener("bitsbytes:goal-draft", goalRequest))
  return <Show when={platform.bitsbytes}><div class="bb-run-controls">
    <Show when={queued().length || editing()}>
      <div class="bb-run-queue" data-component="durable-queue">
        <Show when={queued().length}><div class="bb-run-heading"><span>{language.t("bitsbytes.queued", { count: queued().length })}</span>
          <Show when={run.store.value?.paused}><ButtonV2 size="normal" variant="ghost-muted" onClick={() => action("resume")}>{language.t("bitsbytes.resumeQueue")}</ButtonV2></Show>
        </div></Show>
        <div class="bb-queue-list"><For each={queued()}>{(item, index) => <div class="bb-queue-row">
          <span class="bb-queue-text" title={title(item)}>{title(item)}</span>
          <Show when={item.error}><span class="bb-queue-error" title={item.error}>{language.t("bitsbytes.deliveryUncertain")}</span></Show>
          <button disabled={item.status === "sending"} title={language.t(item.error ? "bitsbytes.retry" : "bitsbytes.steer")} aria-label={language.t(item.error ? "bitsbytes.retry" : "bitsbytes.steer")} onClick={() => action(item.error ? "retry" : "steer", { id: item.id })}><ModeIcon kind="steer" /></button>
          <MenuV2 placement="top-end"><MenuV2.Trigger as={ButtonV2} size="normal" variant="ghost-muted" aria-label={language.t("bitsbytes.queueActions")} disabled={item.status === "sending"}><span aria-hidden="true">⋯</span></MenuV2.Trigger><MenuV2.Portal><MenuV2.Content>
            <MenuV2.Item disabled={!readQueuedDraft(item.prompt.draft)} onSelect={() => void edit(item).catch(() => undefined)}>{language.t("bitsbytes.edit")}</MenuV2.Item>
            <MenuV2.Item disabled={!index()} onSelect={() => move(item.id, -1)}>{language.t("bitsbytes.moveUp")}</MenuV2.Item>
            <MenuV2.Item disabled={index() === queued().length - 1} onSelect={() => move(item.id, 1)}>{language.t("bitsbytes.moveDown")}</MenuV2.Item>
            <MenuV2.Item onSelect={() => { const draft = readQueuedDraft(item.prompt.draft); window.dispatchEvent(new CustomEvent("bitsbytes:side-chat", { detail: { source: run.identity(), directory: sdk().directory, draft: draft ? restoreQueuedDraft(draft) : undefined, variant: local.model.variant.current() ?? null } })) }}>{language.t("bitsbytes.sideChat")}</MenuV2.Item>
          </MenuV2.Content></MenuV2.Portal></MenuV2>
          <button disabled={item.status === "sending"} title={language.t("bitsbytes.delete")} aria-label={language.t("bitsbytes.delete")} onClick={() => action("delete", { id: item.id })}><Icon name="close-small" /></button>
        </div>}</For></div>
        <Show when={editing()}><div class="bb-run-heading bb-queue-editing"><span>{language.t("bitsbytes.editingQueued")}</span><ButtonV2 size="normal" variant="ghost-muted" onClick={() => void cancelEdit().catch(() => undefined)}>{language.t("bitsbytes.cancelEdit")}</ButtonV2></div></Show>
      </div>
    </Show>
    <Show when={run.store.value?.goal && (run.store.value.goal.status !== "complete" || !run.store.value.goal.summaryDismissed) && run.store.value.goal}>{goal => <div class="bb-goal-row" data-status={goal().status}>
      <button class="bb-goal-summary" onClick={() => open("goal")} title={goal().objective}><ModeIcon kind="goal" /><span>{language.t((`bitsbytes.goal.${goal().status}`) as "bitsbytes.goal.active")}</span><span class="bb-goal-objective">{goal().objective}</span></button>
      <span class="bb-goal-stat">{goal().budget ? language.t("bitsbytes.goalTokens", { tokens: goal().tokens, budget: goal().budget! }) : language.t("bitsbytes.goalElapsed", { minutes: Math.floor((goal().status === "active" ? Math.max(0, store.now - goal().started) : goal().elapsed) / 60000) })}</span>
      <Show when={goal().status !== "complete"}><ButtonV2 size="normal" variant="ghost-muted" onClick={() => action(goal().status === "active" ? "goal-pause" : "goal-resume")}>{language.t(goal().status === "active" ? "bitsbytes.pause" : "bitsbytes.resume")}</ButtonV2></Show>
      <MenuV2 placement="top-end"><MenuV2.Trigger as={ButtonV2} size="normal" variant="ghost-muted" aria-label={language.t("bitsbytes.goalActions")}><span aria-hidden="true">⋯</span></MenuV2.Trigger><MenuV2.Portal><MenuV2.Content><MenuV2.Item onSelect={() => open("goal")}>{language.t("bitsbytes.edit")}</MenuV2.Item><MenuV2.Item onSelect={() => action("goal-clear")}>{language.t("bitsbytes.clearGoal")}</MenuV2.Item></MenuV2.Content></MenuV2.Portal></MenuV2>
    </div>}</Show>
    <div class="bb-mode-row">
      <Show when={run.store.value?.mode === "plan"}><button class="bb-mode-chip" onClick={() => { action("mode", { mode: "normal" }); local.agent.set("build") }} title={language.t("bitsbytes.removePlan")}><ModeIcon kind="plan" />{language.t("bitsbytes.plan")}<Icon name="close-small" /></button></Show>
      <Show when={run.store.value?.goalDraft}><button class="bb-mode-chip" onClick={() => action("goal-draft", { enabled: false })} title={language.t("bitsbytes.removeGoal")}><ModeIcon kind="goal" />{language.t("bitsbytes.goal")}<Icon name="close-small" /></button></Show>
    </div>
    <Show when={run.store.error}><p class="bb-queue-error" role="alert">{run.store.error}</p></Show>
    <Show when={store.confirmGoal}><div class="bb-run-heading"><span>{language.t("bitsbytes.replaceGoal")}</span><ButtonV2 size="normal" variant="ghost-muted" onClick={() => setStore("confirmGoal", false)}>{language.t("bitsbytes.cancel")}</ButtonV2><ButtonV2 size="normal" variant="contrast" onClick={() => { action("goal-draft", { enabled: true, replace: true }); setStore("confirmGoal", false) }}>{language.t("bitsbytes.replace")}</ButtonV2></div></Show>
  </div></Show>
}
