import { createEffect, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import type { ChatRun } from "../../main/bitsbytes-runs"
import { bbt, bbError } from "../../bitsbytes/copy"

export function RunPanel(props: { sessionID: string; kind: "plan" | "goal" }) {
  const api = window.api.bitsbytes
  const [store, setStore] = createStore({ run: undefined as ChatRun | undefined, text: "", saved: "", editing: false, budget: "", error: "", revision: 0, followLatest: true })
  const reads = { sequence: 0, active: true }
  const load = async () => {
    const sessionID = props.sessionID, kind = props.kind, sequence = ++reads.sequence
    const current = () => reads.active && sequence === reads.sequence && sessionID === props.sessionID && kind === props.kind
    try {
      const run = await api.call<ChatRun>("runs.get", { sessionID })
      if (!current()) return
      setStore({ run, error: "" })
      if (store.editing) return
      // Follow new revisions only while viewing the latest. Historical review
      // must keep its selected source through unrelated queue/Goal updates.
      const selected = kind === "plan" ? run.plan?.versions.find(version => version.revision === (store.followLatest ? run.plan?.revision : store.revision)) : undefined
      const text = kind === "plan" ? selected?.text ?? run.plan?.text ?? "" : run.goal?.objective ?? ""
      setStore({ text, saved: text, budget: String(run.goal?.budget ?? ""), revision: selected?.revision ?? run.plan?.revision ?? 0, followLatest: selected ? store.followLatest : true })
    } catch (error) { if (current()) setStore("error", bbError(error)) }
  }
  createEffect(() => { props.sessionID; props.kind; setStore({ run: undefined, text: "", saved: "", editing: false, budget: "", error: "", revision: 0, followLatest: true }); void load() })
  const unsubscribe = api.subscribe(event => { if (event.type === "run" && event.sessionID === props.sessionID) void load() })
  onCleanup(() => { reads.active = false; reads.sequence++; unsubscribe() })
  async function action(name: string, args: Record<string, unknown> = {}) {
    const sessionID = props.sessionID, kind = props.kind
    reads.sequence++
    const current = () => reads.active && sessionID === props.sessionID && kind === props.kind
    try { await api.call("runs." + name, { sessionID, ...args }); if (!current()) return; setStore({ editing: false, error: "", ...(name === "plan" ? { followLatest: true } : {}) }); await load() }
    catch (error) { if (current()) setStore("error", bbError(error)) }
  }
  const download = () => { const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([store.text], { type: "text/markdown" })); link.download = props.kind + ".md"; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000) }
  const reason = () => { const value = store.run?.goal?.reason ?? ""; if (value === "no-progress") return bbt("goalNoProgress"); if (value === "budget") return bbt("goalBudgetStop"); if (value === "restart") return bbt("goalRestartStop"); if (value === "stopped") return bbt("goalUserStop"); return value }
  return <div class="bb-run-panel">
    <div class="bb-document-toolbar"><strong>{bbt(props.kind)}</strong><ButtonV2 size="normal" variant="ghost-muted" onClick={() => setStore("editing", !store.editing)}>{bbt("edit")}</ButtonV2><ButtonV2 size="normal" variant="ghost-muted" onClick={download}>{bbt("exportMarkdown")}</ButtonV2>
      <Show when={props.kind === "plan" && store.run?.plan}><select aria-label={bbt("versions")} value={store.revision} onChange={event => { const version = store.run?.plan?.versions.find(row => row.revision === Number(event.currentTarget.value)); if (version) setStore({ text: version.text, saved: version.text, revision: version.revision, followLatest: version.revision === store.run?.plan?.revision }) }}><For each={store.run?.plan?.versions}>{version => <option value={version.revision} selected={store.revision === version.revision}>{bbt("revision").replace("{{revision}}", String(version.revision))}</option>}</For></select></Show>
    </div>
    <Show when={store.error}><p class="bb-error" role="alert">{store.error}</p></Show>
    <Show when={store.editing} fallback={<div class="bb-run-panel-body"><Markdown text={store.text || bbt(props.kind === "plan" ? "planEmpty" : "goalEmpty")} /><Show when={props.kind === "goal" && store.run?.goal?.reason}><p>{reason()}</p><Markdown text={store.run?.goal?.evidence ?? ""} /></Show></div>}>
      <textarea aria-label={bbt(props.kind)} value={store.text} onInput={event => setStore("text", event.currentTarget.value)} />
      <Show when={props.kind === "goal"}><label>{bbt("tokenBudget")}<input type="number" min="0" value={store.budget} onInput={event => setStore("budget", event.currentTarget.value)} /></label></Show>
      <div class="bb-document-toolbar"><ButtonV2 size="normal" variant="contrast" onClick={() => void action(props.kind === "plan" ? "plan" : "goal-edit", props.kind === "plan" ? { text: store.text } : { objective: store.text, budget: Number(store.budget) })}>{bbt("save")}</ButtonV2><ButtonV2 size="normal" variant="ghost-muted" onClick={() => { setStore({ editing: false, text: store.saved }); void load() }}>{bbt("revert")}</ButtonV2></div>
    </Show>
    <Show when={props.kind === "plan" && store.run?.plan && !store.editing}><div class="bb-document-toolbar"><ButtonV2 size="normal" variant="contrast" onClick={() => void action("implement", { revision: store.revision })}>{bbt("implementPlan")}</ButtonV2></div></Show>
  </div>
}
