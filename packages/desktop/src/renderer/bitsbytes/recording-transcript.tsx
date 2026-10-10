import { createSignal, For, Show } from "solid-js"
import type { Job } from "../../bitsbytes/types"
import { bbError, bbt } from "../../bitsbytes/copy"

export function RecordingTranscript(props: { job: Job; close: () => void; saved: (job: Job) => void }) {
  const [names, setNames] = createSignal({ ...props.job.speakerNames })
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const speakers = () => [...new Set(props.job.segments.flatMap(segment => segment.speaker ? [segment.speaker] : []))]
  const label = (speaker: string) => bbt("audioSpeakerLabel").replace("{{number}}", String(Number(speaker.split("_")[1]) + 1))
  async function save() {
    setBusy(true)
    setError("")
    try {
      const job = await window.api.bitsbytes.call<Job>("job.speakers", { id: props.job.id, names: names() })
      props.saved(job)
      setNames({ ...job.speakerNames })
    } catch (reason) { setError(bbError(reason)) }
    finally { setBusy(false) }
  }
  return <div class="bb-modal" role="dialog" aria-modal="true" aria-label={props.job.title}>
    <div class="bb-modal-card">
      <header><h2>{props.job.title}</h2><button aria-label={bbt("closeTranscript")} onClick={props.close}>×</button></header>
      <Show when={speakers().length}>
        <details class="bb-speaker-names"><summary>{bbt("audioSpeakerNames")}</summary>
          <p class="bb-subtle">{bbt("audioSpeakerNamesHint")}</p>
          <div class="bb-speaker-inputs"><For each={speakers()}>{speaker => <label>{label(speaker)}<input maxlength={80} disabled={busy()} value={names()[speaker] ?? ""} placeholder={label(speaker)} onInput={event => setNames({ ...names(), [speaker]: event.currentTarget.value })} /></label>}</For></div>
          <button disabled={busy()} onClick={() => void save()}>{bbt("save")}</button>
          <Show when={error()}><p class="bb-error" role="alert">{error()}</p></Show>
        </details>
      </Show>
      <pre>{props.job.transcript || bbt(props.job.audioDiarization && props.job.recording ? "audioDiarizationWaiting" : "running")}</pre>
    </div>
  </div>
}
