import { createEffect, createMemo, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams, useSearchParams } from "@solidjs/router"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { usePlatform } from "../context/platform"
import { useLanguage } from "../context/language"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import type { Part } from "@opencode-ai/sdk/v2/client"
import { usePrompt } from "../context/prompt"
import { useLocal } from "../context/local"
import { draftAccessKey } from "./chat-access"
import type { FollowupDraft } from "./prompt-input/submit"
import { readQueuedDraft, restoreQueuedDraft } from "./chat-run-draft"
import { createQueuedEditGuard, moveQueuedInput, reorderQueuedInput } from "./chat-run-controls"
import "./chat-runs.css"
import "./chat-runs-rail.css"

export type RunState = {
  sessionID: string; mode: "normal" | "plan"; goalDraft: boolean; paused: boolean; error: string
  goalDraftDurationMs?: number
  queue: { id: string; status: string; sentAt?: number; editing?: boolean; editingSince?: number; presentation?: string; error?: string; prompt: { directory?: string; model?: { providerID: string; modelID: string }; agent?: string; variant?: string; legacyParts?: unknown[]; draft?: FollowupDraft; text: string } }[]
  goal?: { id: string; objective: string; status: string; reason: string; evidence: string; tokens: number; elapsed: number; started: number; budget?: number; summaryDismissed?: boolean; activeSince?: number; minActiveDurationMs?: number }
  plan?: { id: string; revision: number; text: string; versions: { revision: number; text: string }[] }
}

export function useChatRun() {
  const platform = usePlatform(), sdk = useSDK(), sync = useSync(), params = useParams(), language = useLanguage()
  const [search] = useSearchParams<{ draftId?: string }>()
  const [store, setStore] = createStore<{ value?: RunState; error: string }>({ error: "" })
  const identity = () => params.id ?? draftAccessKey(sdk().scope, sdk().directory, search.draftId)
  let generation = 0, disposed = false, selected = ""
  const projected = new Set<string>()
  createEffect(() => {
    const run = store.value
    if (!run) return
    const messages = sync().data.message[run.sessionID] ?? []
    for (const item of run.queue) {
      const message = messages.find(message => message.id === item.id)
      if (message?.role === "user" && message.execution) { projected.delete(item.id); continue }
      if (item.presentation !== "transcript") {
        if (projected.delete(item.id)) sync().session.optimistic.remove({ directory: item.prompt.directory, sessionID: run.sessionID, messageID: item.id })
        continue
      }
      if (message || projected.has(item.id) || !item.prompt.model) continue
      const parts = (item.prompt.legacyParts ?? []).flatMap((value): Part[] => {
        if (!value || typeof value !== "object") return []
        const part = value as Record<string, unknown>
        if (typeof part.id !== "string") return []
        const common = { id: part.id, sessionID: run.sessionID, messageID: item.id }
        if (part.type === "text" && typeof part.text === "string") return [{ ...common, type: "text", text: part.text, synthetic: part.synthetic === true }]
        if (part.type === "file" && typeof part.url === "string" && typeof part.mime === "string") return [{ ...common, type: "file", mime: part.mime, url: part.url, filename: typeof part.filename === "string" ? part.filename : undefined }]
        if (part.type === "agent" && typeof part.name === "string") return [{ ...common, type: "agent", name: part.name }]
        return []
      })
      if (!parts.length) continue
      projected.add(item.id)
      sync().session.optimistic.add({ directory: item.prompt.directory, sessionID: run.sessionID, message: { id: item.id, sessionID: run.sessionID, role: "user", time: { created: item.sentAt ?? Date.now() }, agent: item.prompt.agent ?? "build", model: { ...item.prompt.model, variant: item.prompt.variant } }, parts })
    }
  })
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
  const [store, setStore] = createStore({ confirmGoal: false, editing: "", now: Date.now(), tick: performance.now(), dragging: "" })
  const goalClock = createMemo(() => {
    const goal = run.store.value?.goal
    return goal ? { id: goal.id, elapsed: goal.elapsed, running: goal.status === "active" && goal.activeSince !== undefined, tick: performance.now() } : undefined
  })
  const goalElapsed = () => { const anchor = goalClock(); return anchor ? anchor.elapsed + (anchor.running ? Math.max(0, store.tick - anchor.tick) : 0) : 0 }
  const queued = createMemo(() => run.store.value?.queue.filter(item => !item.editing && item.status !== "sending" && item.presentation !== "transcript") ?? [])
  const editing = createMemo(() => run.store.value?.queue.find(item => item.editing)?.id ?? "")
  const editGuard = createQueuedEditGuard()
  createEffect(() => { if (editGuard.select(run.identity())) setStore({ editing: "" }) })
  onCleanup(editGuard.invalidate)
  const timer = setInterval(() => { if (run.store.value?.goal?.status === "active" || editing()) setStore({ now: Date.now(), tick: performance.now() }) }, 1000)
  onCleanup(() => clearInterval(timer))
  const action = (name: string, args: Record<string, unknown> = {}) => void run.call(name, args).catch(() => undefined)
  const move = (id: string, step: -1 | 1) => { const ids = moveQueuedInput(run.store.value?.queue ?? [], id, step); if (ids) action("reorder", { ids }) }
  const title = (item: RunState["queue"][number]) => readQueuedDraft(item.prompt.draft)?.prompt.map(part => "content" in part ? part.content : `[${part.filename}]`).join("").trim() || item.prompt.text
  async function edit(item: RunState["queue"][number]) {
    const draft = readQueuedDraft(item.prompt.draft)
    if (!draft) return
    const sessionID = run.identity(), request = editGuard.begin(sessionID)
    await Promise.all([local.session.ready.promise, prompt.ready.promise])
    if (!editGuard.current(request, run.identity())) return
    await run.call("edit", { id: item.id })
    if (!editGuard.current(request, run.identity()) || !run.store.value?.queue.some(row => row.id === item.id && row.editing)) return
    setStore({ editing: item.id })
    prompt.set(restoreQueuedDraft(draft).prompt)
    for (const context of prompt.context.items()) prompt.context.remove(context.key)
    for (const context of draft.context) prompt.context.add(context)
    local.agent.set(draft.agent)
    local.model.set({ providerID: draft.model.providerID, modelID: draft.model.modelID })
    local.model.variant.set(draft.variant)
  }
  createEffect(() => { if (store.editing && !run.store.value?.queue.some(item => item.id === store.editing && item.editing)) setStore({ editing: "" }) })
  const goalRequest = (event: Event) => { if ((event as CustomEvent).detail.sessionID !== run.identity()) return; if (run.store.value?.goal && run.store.value.goal.status !== "complete") setStore("confirmGoal", true); else action("goal-draft", { enabled: true }) }
  window.addEventListener("bitsbytes:goal-draft", goalRequest)
  onCleanup(() => window.removeEventListener("bitsbytes:goal-draft", goalRequest))
  return <Show when={platform.bitsbytes}><div class="bb-run-controls">
    <Show when={queued().length && run.store.value?.paused}><div class="bb-run-heading"><ButtonV2 size="normal" variant="ghost-muted" onClick={() => action("resume")}>{language.t("bitsbytes.resumeQueue")}</ButtonV2></div></Show>
    <Show when={run.store.value?.goal && (run.store.value.goal.status !== "complete" || !run.store.value.goal.summaryDismissed) && run.store.value.goal}>{goal => <div class="bb-goal-row" data-status={goal().status}>
      <div class="bb-goal-summary" title={goal().objective}><ModeIcon kind="goal" /><span>{language.t((`bitsbytes.goal.${goal().status}`) as "bitsbytes.goal.active")}</span><span class="bb-goal-objective">{goal().objective}</span></div>
      <span class="bb-goal-stat">{language.t("bitsbytes.goalElapsed", { minutes: Math.floor(goalElapsed() / 60000) })}<Show when={goal().budget}> · {language.t("bitsbytes.goalTokens", { tokens: goal().tokens, budget: goal().budget! })}</Show></span>
      <button class="bb-goal-icon" onClick={() => action("goal-clear")} title={language.t("bitsbytes.clearGoal")} aria-label={language.t("bitsbytes.clearGoal")}><Icon name="close-small" /></button>
      <Show when={goal().status !== "complete"}><button class="bb-goal-icon" onClick={() => action(goal().status === "active" ? "goal-pause" : "goal-resume")} title={language.t(goal().status === "active" ? "bitsbytes.pause" : "bitsbytes.resume")} aria-label={language.t(goal().status === "active" ? "bitsbytes.pause" : "bitsbytes.resume")}>{goal().status === "active" ? "Ⅱ" : "▷"}</button></Show>
    </div>}</Show>
    <div class="bb-mode-row">
      <Show when={run.store.value?.mode === "plan"}><button class="bb-mode-chip" onClick={() => { action("mode", { mode: "normal" }); local.agent.set("build") }} title={language.t("bitsbytes.removePlan")}><ModeIcon kind="plan" />{language.t("bitsbytes.plan")}<Icon name="close-small" /></button></Show>
      <Show when={run.store.value?.goalDraft}><button class="bb-mode-chip" onClick={() => action("goal-draft", { enabled: false })} title={language.t("bitsbytes.removeGoal")}><ModeIcon kind="goal" />{language.t("bitsbytes.goal")}<Icon name="close-small" /></button></Show>
    </div>
    <Show when={run.store.error}><p class="bb-queue-error" role="alert">{run.store.error}</p></Show>
    <For each={run.store.value?.queue.filter(item => item.presentation === "transcript" && item.error) ?? []}>{item => <div class="bb-run-heading" role="alert"><span class="bb-queue-error">{language.t("bitsbytes.deliveryUncertain")}</span><ButtonV2 size="normal" variant="ghost-muted" onClick={() => action("retry", { id: item.id })}>{language.t("bitsbytes.retry")}</ButtonV2></div>}</For>
    <Show when={store.confirmGoal}><div class="bb-run-heading"><span>{language.t("bitsbytes.replaceGoal")}</span><ButtonV2 size="normal" variant="ghost-muted" onClick={() => setStore("confirmGoal", false)}>{language.t("bitsbytes.cancel")}</ButtonV2><ButtonV2 size="normal" variant="contrast" onClick={() => { action("goal-draft", { enabled: true, replace: true }); setStore("confirmGoal", false) }}>{language.t("bitsbytes.replace")}</ButtonV2></div></Show>
    <Show when={queued().length}>
      <div class="bb-run-queue" data-component="durable-queue" role="group" aria-label={language.t("bitsbytes.queued", { count: queued().length })}>
        <div class="bb-queue-list"><For each={queued()}>{(item, index) => <div class="bb-queue-row" draggable={item.status !== "sending"} onDragStart={event => { setStore("dragging", item.id); event.dataTransfer?.setData("text/plain", item.id) }} onDragEnd={() => setStore("dragging", "")} onDragOver={event => { if (store.dragging && store.dragging !== item.id) event.preventDefault() }} onDrop={event => { event.preventDefault(); const ids = reorderQueuedInput(run.store.value?.queue ?? [], store.dragging, item.id); setStore("dragging", ""); if (ids) action("reorder", { ids }) }}>
          <span class="bb-queue-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4H2.5v8.5H11v-2M6 5.5h5m-2-2 2 2-2 2" /></svg></span>
          <span class="bb-queue-text" title={title(item)}>{title(item)}</span>
          <Show when={item.error}><span class="bb-queue-error" title={item.error}>{language.t("bitsbytes.deliveryUncertain")}</span></Show>
          <div class="bb-queue-actions">
          <button class="bb-queue-steer" disabled={item.status === "sending"} title={language.t(item.error ? "bitsbytes.retry" : "bitsbytes.queueSteer")} aria-label={language.t(item.error ? "bitsbytes.retry" : "bitsbytes.queueSteer")} onClick={() => action(item.error ? "retry" : "steer", { id: item.id })}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5V7a3 3 0 0 0 3 3h6m-2.5-2.5L12 10l-2.5 2.5" /></svg><span>{language.t(item.error ? "bitsbytes.retry" : "bitsbytes.queueSteer")}</span></button>
          <button disabled={item.status === "sending"} title={language.t("bitsbytes.delete")} aria-label={language.t("bitsbytes.delete")} onClick={() => action("delete", { id: item.id })}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="0.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5.5h9M7.5 5.5v-3h4v3M6 5.5l.5 8h6l.5-8M8.5 8v3.5M10.5 8v3.5" /></svg></button>
          <MenuV2 placement="top-end"><MenuV2.Trigger as={ButtonV2} size="normal" variant="ghost-muted" aria-label={language.t("bitsbytes.queueActions")} disabled={item.status === "sending"}><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="5.5" cy="8" r="0.75" /><circle cx="9.5" cy="8" r="0.75" /><circle cx="13" cy="8" r="0.75" /></svg></MenuV2.Trigger><MenuV2.Portal><MenuV2.Content>
            <MenuV2.Item disabled={!readQueuedDraft(item.prompt.draft)} onSelect={() => void edit(item).catch(() => undefined)}>{language.t("bitsbytes.edit")}</MenuV2.Item>
            <MenuV2.Item disabled={!index()} onSelect={() => move(item.id, -1)}>{language.t("bitsbytes.moveUp")}</MenuV2.Item>
            <MenuV2.Item disabled={index() === queued().length - 1} onSelect={() => move(item.id, 1)}>{language.t("bitsbytes.moveDown")}</MenuV2.Item>
            <MenuV2.Item onSelect={() => { const draft = readQueuedDraft(item.prompt.draft); window.dispatchEvent(new CustomEvent("bitsbytes:side-chat", { detail: { source: run.identity(), directory: sdk().directory, draft: draft ? restoreQueuedDraft(draft) : undefined, variant: local.model.variant.current() ?? null } })) }}>{language.t("bitsbytes.sideChat")}</MenuV2.Item>
          </MenuV2.Content></MenuV2.Portal></MenuV2>
          </div>
        </div>}</For></div>
      </div>
    </Show>
  </div></Show>
}
