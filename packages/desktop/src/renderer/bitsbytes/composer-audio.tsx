import { For, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { createStore } from "solid-js/store"
import type { Platform } from "@opencode-ai/app"
import type { Job, State } from "../../bitsbytes/types"
import { bbt, bbError } from "../../bitsbytes/copy"

type Capture = Parameters<NonNullable<Platform["composerAudio"]>>[0]["capture"]
const time = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`

export function createComposerAudio() {
  const api = window.api.bitsbytes
  const [state, setState] = createStore({ job: undefined as Job | undefined, recovery: undefined as Job | undefined, ready: false, preparing: false, root: "", engine: "", busy: "", error: "", duration: 0, bars: Array<number>(48).fill(2) })
  let receiver: Capture | undefined
  let destination: ReturnType<Capture> | undefined
  let recordingIdentity: unknown
  let cancelled = false
  let generation = 0
  const queue: Job[] = []
  const refresh = () => api.call<State>("state").then(next => {
    setState({ ready: next.workerReady, preparing: Boolean(next.audioPreparing), root: next.root, engine: next.settings.engine })
    const active = next.jobs.find(job => job.recording)
    if (active) setState("job", active)
    if (!active && !state.busy && state.job?.recording) setState("job", undefined)
  }).catch(error => setState("error", bbError(error)))
  void refresh()
  const unsubscribe = api.subscribe(event => {
    if (event.type === "refresh") { void refresh(); return }
    if (event.type === "job" && (event.job.recording || event.job.id === state.job?.id)) { setState("job", event.job); return }
    if (event.type === "duration" && event.id === state.job?.id) { setState("duration", event.duration); return }
    if (event.type === "meter" && state.job?.recording) setState("bars", bars => [...bars.slice(1), Math.max(2, Math.min(24, event.level * 180))])
  })
  onCleanup(unsubscribe)

  async function deliver(job: Job, target = receiver?.()) {
    if (!job.transcript.trim()) throw new Error(bbt("bb.error.transcriptEmpty"))
    if (!target) { queue.push(job); return }
    const reference = await api.call<{ revision: number }>("transcript.snapshot", { id: job.id })
    target({ text: job.transcript, jobID: job.id, revision: reference.revision, path: `${state.root}\\recordings\\${job.id}\\transcript.txt` })
    setState("error", "")
  }
  async function start(capture: Capture, identity?: unknown) {
    if (state.busy || state.job?.recording) return
    destination = capture()
    recordingIdentity = identity
    cancelled = false
    const current = ++generation
    setState({ busy: "start", recovery: undefined, error: "", duration: 0, bars: Array<number>(48).fill(2) })
    try { const job = await api.call<Job>("record.start"); if (current === generation) setState("job", job) }
    catch (error) { if (current === generation) { destination = undefined; setState("error", bbError(error)) } }
    finally { if (current === generation) setState("busy", "") }
  }
  async function stop() {
    const job = state.job
    if (!job || state.busy) return
    const current = generation
    setState({ busy: "stop", error: "" })
    try {
      const result = await api.call<Job>("record.stop", { id: job.id })
      if (!cancelled && current === generation) {
        if (result.status !== "transcribed") throw new Error(result.error || bbt("bb.error.interrupted"))
        await deliver(result, destination ?? receiver?.())
      }
    } catch (error) { if (!cancelled && current === generation) setState({ error: bbError(error), recovery: job }) }
    finally { if (current === generation) { if (!state.recovery) destination = undefined; setState({ busy: "", job: undefined }) } }
  }
  async function retry() {
    const job = state.recovery
    if (!job || state.busy || state.job?.recording) return
    const current = generation
    cancelled = false
    setState({ busy: "retry", error: "" })
    try {
      const result = await api.call<Job>("transcribe", { id: job.id })
      if (cancelled || current !== generation) return
      if (result.status !== "transcribed") throw new Error(result.error || bbt("bb.error.interrupted"))
      await deliver(result, destination)
      destination = undefined
      setState("recovery", undefined)
    } catch (error) { if (!cancelled && current === generation) setState("error", bbError(error)) }
    finally { if (current === generation) setState("busy", "") }
  }
  async function cancel() {
    const job = state.job ?? state.recovery
    if ((!job && state.busy !== "start") || state.busy === "cancel") return
    const starting = state.busy === "start"
    const current = ++generation
    cancelled = true
    setState({ busy: "cancel", error: "" })
    try { await api.call("record.cancel", starting ? { start: true } : { id: job!.id }) }
    catch (error) { if (current === generation) setState("error", bbError(error)) }
    finally { if (current === generation) { destination = undefined; setState({ busy: "", job: undefined, recovery: undefined }) } }
  }
  async function pause() {
    if (!state.job || state.busy) return
    const current = generation
    const action = state.job.status === "paused" ? "record.resume" : "record.pause"
    setState("busy", "pause")
    try { const job = await api.call<Job>(action); if (current === generation) setState("job", job) }
    catch (error) { if (current === generation) setState("error", bbError(error)) }
    finally { if (current === generation) setState("busy", "") }
  }
  const Control: NonNullable<Platform["composerAudio"]> = props => {
    let element!: HTMLDivElement
    const [notice, setNotice] = createStore({ left: 12, bottom: 12, width: 320, height: 240, visible: false })
    onMount(() => {
      const focus = () => { receiver = props.capture }
      const composer = element.closest("form") ?? element.closest("[data-bb-chat]")
      composer?.addEventListener("focusin", focus)
      composer?.addEventListener("pointerdown", focus)
      if (!receiver) { receiver = props.capture; queue.splice(0).forEach(job => void deliver(job, props.capture()).catch(error => setState("error", bbError(error)))) }
      onCleanup(() => { composer?.removeEventListener("focusin", focus); composer?.removeEventListener("pointerdown", focus) })
      const chat = element.closest(".bb-workspace-chat, .bb-embedded-chat, [data-component=session-new-design]")
      const form = element.closest("form") ?? element
      const position = () => {
        const rect = form.getBoundingClientRect()
        const bounds = chat?.getBoundingClientRect() ?? rect
        const width = Math.min(360, Math.max(96, bounds.width - 24), innerWidth - 24)
        const end = element.getBoundingClientRect().right
        setNotice({
          left: Math.max(12, Math.min(innerWidth - width - 12, Math.max(bounds.left + 12, end - width))),
          bottom: Math.max(12, innerHeight - rect.top + 8), width,
          height: Math.max(96, rect.top - 20),
          visible: rect.width > 0 && rect.top > 116 && !chat?.hasAttribute("inert") && chat?.getAttribute("aria-hidden") !== "true",
        })
      }
      const resize = new ResizeObserver(position)
      resize.observe(form)
      if (chat) resize.observe(chat)
      const attributes = new MutationObserver(position)
      if (chat) attributes.observe(chat, { attributes: true, attributeFilter: ["inert", "aria-hidden"] })
      window.addEventListener("resize", position)
      window.addEventListener("scroll", position, true)
      position()
      onCleanup(() => { resize.disconnect(); attributes.disconnect(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true) })
    })
    onCleanup(() => { if (receiver === props.capture) receiver = undefined })
    const owns = () => !recordingIdentity || props.identity?.() === recordingIdentity
    return <div ref={element} class="bb-composer-audio" classList={{ "bb-audio-active": owns() && Boolean(state.job?.recording || state.busy) }}>
      <Show when={owns() && (state.job?.recording || state.busy)} fallback={
        <><Show when={owns() && notice.visible && (state.error || state.recovery)}><Portal><div class="bb-audio-recovery" role="status" style={{ left: `${notice.left}px`, bottom: `${notice.bottom}px`, width: `${notice.width}px`, "max-height": `${notice.height}px` }}>
          <span>{state.error || bbt("audioSaved")}</span>
          <div><Show when={state.recovery}><button type="button" data-action="retry-transcription" disabled={Boolean(state.busy)} onClick={() => void retry()}>{bbt("audioRetry")}</button></Show>
            <button type="button" onClick={() => window.dispatchEvent(new Event("bitsbytes:settings"))}>{bbt("audioSettings")}</button>
            <Show when={state.recovery}><button type="button" onClick={() => window.dispatchEvent(new CustomEvent("bitsbytes:utility-select", { detail: { tab: "recordings" } }))}>{bbt("recordings")}</button></Show>
          </div>
        </div></Portal></Show>
        <button type="button" class="bb-audio-button" data-action="record-audio" disabled={Boolean(state.busy || state.job?.recording)} aria-label={bbt("recordAudio")} title={!state.ready ? bbt(state.engine === "openrouter" ? "audioCloudSetupHint" : "setupHint") : bbt(state.engine === "openrouter" ? "recordingOpenrouter" : "recordAudio")} onClick={() => void start(props.capture, props.identity?.())}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 11v1a6 6 0 0 0 12 0v-1M12 18v3M9 21h6"/></svg>
        </button></>
      }>
        <button type="button" class="bb-audio-button" data-action="cancel-recording" aria-label={bbt("cancelRecording")} title={bbt("cancelRecording")} disabled={state.busy === "cancel"} onClick={() => void cancel()}><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg></button>
        <Show when={state.busy !== "start"}><span class="bb-audio-time">{time(Math.max(state.duration, state.job?.duration ?? 0))}</span></Show>
        <Show when={!state.busy || state.busy === "pause"} fallback={<span class="bb-audio-progress" role="status">{bbt(state.preparing ? "audioPreparing" : state.busy === "start" ? "audioStarting" : state.busy === "cancel" ? "running" : "transcribing")}</span>}>
          <span class="bb-audio-wave" aria-hidden="true"><For each={state.bars}>{height => <i style={{ height: `${state.job?.status === "paused" ? 2 : height}px` }} />}</For></span>
          <button type="button" class="bb-audio-button" aria-label={bbt(state.job?.status === "paused" ? "resume" : "pause")} title={bbt(state.job?.status === "paused" ? "resume" : "pause")} disabled={Boolean(state.busy)} onClick={() => void pause()}><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><Show when={state.job?.status === "paused"} fallback={<><rect x="7" y="5" width="3" height="14" rx="1"/><rect x="14" y="5" width="3" height="14" rx="1"/></>}><path d="m8 5 11 7-11 7z"/></Show></svg></button>
          <button type="button" class="bb-audio-button bb-audio-stop" data-action="attach-recording" aria-label={bbt("stopRecording")} title={bbt("stopRecording")} disabled={Boolean(state.busy)} onClick={() => void stop()}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg></button>
        </Show>
      </Show>
    </div>
  }
  return { Control, active: (identity?: unknown) => (!identity || !recordingIdentity || identity === recordingIdentity) && Boolean(state.job?.recording || state.busy), insert: (job: Job) => { void deliver(job).catch(error => setState("error", bbError(error))) } }
}
