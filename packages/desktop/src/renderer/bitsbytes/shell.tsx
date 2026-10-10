import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { ParentProps } from "solid-js"
import type { Job, State } from "../../bitsbytes/types"
import { bbt, bbError } from "../../bitsbytes/copy"
import { audioSupportsDiarization } from "../../bitsbytes/audio"
import { RecordingTranscript } from "./recording-transcript"
import { Portal } from "solid-js/web"
import "./style.css"

const time = (seconds: number) => `${Math.floor(seconds / 3600).toString().padStart(2, "0")}:${Math.floor(seconds / 60 % 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`

export function BitsBytesShell(props: ParentProps<{ audio: { insert: (job: Job) => void } }>) {
  const api = window.api.bitsbytes
  const [state, setState] = createSignal<State>()
  const [tab, setTab] = createSignal<"chats" | "skills" | "recordings" | "settings">("chats")
  const [utilityHost, setUtilityHost] = createSignal<HTMLElement>()
  const selectTab = (value: "chats" | "skills" | "recordings" | "settings") => {
    setTab(value)
    window.dispatchEvent(new CustomEvent("bitsbytes:utility-state", { detail: { tab: value } }))
  }
  const [busy, setBusy] = createSignal("")
  const [notice, setNotice] = createSignal("")
  const [error, setError] = createSignal("")
  const [transcript, setTranscript] = createSignal<Job>()
  const viewedTranscript = createMemo(() => { const selected = transcript(); return selected && (state()?.jobs.find(job => job.id === selected.id) ?? selected) })
  const active = createMemo(() => state()?.jobs.find((job) => job.recording))

  async function refresh() {
    const next = await api.call<State>("state")
    setState(next)
  }
  function navigate(result: unknown) {
    if (!result || typeof result !== "object" || !("sessionID" in result) || !("directory" in result)) return
    selectTab("chats")
    window.dispatchEvent(new CustomEvent("bitsbytes:session", { detail: result }))
  }
  async function run(method: string, args: Record<string, unknown> = {}) {
    setBusy(method); setError(""); setNotice("")
    try {
      const result = await api.call(method, args)
      navigate(result)
      await refresh()
      if (["audio.import", "transcribe"].includes(method) && result && typeof result === "object" && "transcript" in result) addTranscript(result as Job)
      if (method === "share.test") setNotice(bbt("shareOK"))
      return result
    } catch (reason) { setError(bbError(reason)) }
    finally { setBusy("") }
  }
  onMount(() => {
    const findHost = () => { const host = document.getElementById("bitsbytes-utility-content"); if (host) setUtilityHost(host) }
    findHost()
    const host = (event: Event) => { const element = (event as CustomEvent).detail; if (element instanceof HTMLElement) setUtilityHost(element) }
    const select = (event: Event) => { const value = (event as CustomEvent).detail?.tab; if (value === "chats" || value === "skills" || value === "recordings") setTab(value) }
    window.addEventListener("bitsbytes:utility-host", host)
    window.addEventListener("bitsbytes:utility-select", select)
    onCleanup(() => { window.removeEventListener("bitsbytes:utility-host", host); window.removeEventListener("bitsbytes:utility-select", select) })
    void refresh().catch((reason) => setError(bbError(reason)))
    const unsubscribe = api.subscribe((event) => {
      if (event.type === "meter" || event.type === "duration" || event.type === "browser" || event.type === "artifact" || event.type === "image") return
      if (event.type === "notice") { setError(bbError(event.message)); return }
      if (event.type === "job") {
        setState((current) => current ? { ...current, jobs: [event.job, ...current.jobs.filter((job) => job.id !== event.job.id)].sort((a,b) => b.created - a.created) } : current)
        return
      }
      void refresh()
    })
    onCleanup(unsubscribe)
    const openSettings = () => { selectTab("chats"); window.dispatchEvent(new Event("bitsbytes:open-settings")) }
    window.addEventListener("bitsbytes:settings", openSettings)
    onCleanup(() => window.removeEventListener("bitsbytes:settings", openSettings))
  })

  function addTranscript(job: Job) {
    try { props.audio.insert(job); selectTab("chats") }
    catch (reason) { setError(bbError(reason)) }
  }
  async function showDocument(job: Job) {
    if (!job.artifact) return
    selectTab("chats")
    if (job.sessionID) navigate({ sessionID: job.sessionID, directory: state()!.root + "\\workspace" })
    window.dispatchEvent(new CustomEvent("bitsbytes:open-document", { detail: { path: job.artifact.path, sessionID: job.sessionID } }))
  }

  return <div class="bb-shell">
    <main class="bb-main">
      <Show when={busy() || error() || notice()}><div classList={{ "bb-banner": true, "bb-error": Boolean(error()) }} role="status">{error() || notice() || bbt("running")}</div></Show>
      <div class="bb-content">
        <div class="bb-chat">{props.children}</div>
        <Show when={utilityHost()}>{host => <Portal mount={host()}>
        <Show when={tab() === "recordings"}>
          <section class="bb-page"><h1>{bbt("recordings")}</h1><p class="bb-subtle">{state()?.settings.engine === "openrouter" ? bbt("openrouterAudioHint") : bbt("localHint")}</p>
            <button disabled={Boolean(busy()) || Boolean(active()) || !state()?.workerReady} onClick={() => void run("audio.import")}>{bbt("importAudio")}</button>
            <Show when={state()?.jobs.length} fallback={<div class="bb-empty">{bbt("emptyRecordings")}</div>}>
              <For each={state()?.jobs}>{(job) => <article class="bb-card bb-job">
                <div><h2>{job.title}</h2><p class="bb-subtle">{time(job.duration)} · {job.engine === "groq" ? bbt("previousAudioProvider") : job.engine} · {job.status} · {job.chunks.filter((chunk) => chunk.done).length}/{job.chunks.length}</p><Show when={job.audioDiarization && job.recording}><p class="bb-subtle">{bbt("audioDiarizationWaiting")}</p></Show><Show when={job.error}><p class="bb-error">{bbError(job.error)}</p></Show></div>
                <div class="bb-actions"><Show when={job.recording}><button onClick={() => void run("record.cancel", { id: job.id })}>{bbt("cancelRecording")}</button></Show><button onClick={() => setTranscript(job)}>{bbt("transcript")}</button>
                  <Show when={job.sessionID}><button onClick={() => navigate({ sessionID: job.sessionID, directory: state()!.root + "\\workspace" })}>{bbt("openChat")}</button></Show>
                  <Show when={job.artifact}>{(artifact) => <><button onClick={() => void showDocument(job)}>{bbt("preview")}</button><button onClick={() => void run("file.open", { path: artifact().path })}>{bbt("openWord")}</button><span class="bb-badge">{bbt(artifact().used_fallback ? "savedLocal" : "savedServer")}</span><Show when={artifact().used_fallback}><button onClick={() => void run("docx.retry", { id: job.id })}>{bbt("retryServer")}</button></Show></>}</Show>
                  <Show when={!["complete", "transcribed", "transcribing"].includes(job.status) && !job.recording}><button disabled={Boolean(busy())} onClick={() => void run("transcribe", { id: job.id })}>{bbt("retry")}</button></Show>
                  <Show when={job.transcript && !job.recording && job.status !== "transcribing"}><button disabled={Boolean(busy())} onClick={() => addTranscript(job)}>{bbt("addToChat")}</button></Show>
                  <Show when={!job.audioDiarization && !job.recording && job.status === "transcribed" && state()?.settings.audioDiarization !== false && audioSupportsDiarization(state()?.settings.audioModel)}><button disabled={Boolean(busy())} onClick={() => void run("transcribe", { id: job.id })}>{bbt("audioSeparateExisting")}</button></Show>
                  <Show when={job.skill && !job.recording && job.status !== "transcribing"}><button disabled={Boolean(busy())} onClick={() => void run("template.refresh", { id: job.id })}>{bbt("refreshTemplate")}</button></Show>
                  <Show when={job.status === "transcribing"}><button onClick={() => void run("transcribe.cancel", { id: job.id })}>{bbt("cancel")}</button></Show>
                  <button disabled={job.recording || job.status === "transcribing"} onClick={() => void run("job.delete", { id: job.id })}>{bbt("delete")}</button>
                </div></article>}</For>
            </Show>
          </section>
        </Show>
        </Portal>}</Show>
      </div>
    </main>
    <Show when={viewedTranscript()}>{job => <RecordingTranscript job={job()} close={() => setTranscript(undefined)} saved={job => { setTranscript(job); void refresh() }} />}</Show>
  </div>
}
