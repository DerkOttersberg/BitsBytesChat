import { For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import type { AudioModel, Settings, State } from "../../bitsbytes/types"
import { audioSupportsDiarization } from "../../bitsbytes/audio"
import { bbt, bbError } from "../../bitsbytes/copy"

export function BitsBytesSettings(props: { page: "audio" | "tools" }) {
  const api = window.api.bitsbytes
  const [store, setStore] = createStore({ data: undefined as State | undefined, values: {} as Settings, devices: [] as { id: number; name: string }[], busy: "", error: "", notice: "", audioModels: [] as AudioModel[], modelsLoading: false, modelsError: "" })
  let mounted = true
  let discovery = 0
  async function loadAudioModels() {
    const request = ++discovery
    setStore({ modelsLoading: true, modelsError: "" })
    try {
      const models = await api.call<AudioModel[]>("audio.models")
      if (mounted && request === discovery) setStore("audioModels", models)
    } catch (error) { if (mounted && request === discovery) setStore("modelsError", bbError(error)) }
    finally { if (mounted && request === discovery) setStore("modelsLoading", false) }
  }
  async function refresh(reset = false) {
    const data = await api.call<State>("state")
    if (!store.data || reset) setStore("values", { ...data.settings })
    setStore("data", data)
    if (props.page === "audio" && data.workerReady) setStore("devices", await api.call<{ id: number; name: string }[]>("devices").catch(() => []))
  }
  async function run(method: string, args: Record<string, unknown> = {}, reset = method === "settings.save") {
    setStore({ busy: method, error: "", notice: "" })
    try {
      await api.call(method, args)
      await refresh(reset)
      if (method === "share.test") setStore("notice", bbt("shareOK"))
      if (method === "models.list") setStore("notice", bbt("modelsUpdated"))
    } catch (error) { setStore("error", bbError(error)) }
    finally { setStore("busy", "") }
  }
  const saveAudio = (values: Partial<Settings>) => {
    setStore("values", values)
    // Persist discrete choices immediately without replacing other unsaved fields.
    return run("settings.save", { engine: "openrouter", ...values }, false)
  }
  const save = () => run("settings.save", props.page === "audio" ? { engine: "openrouter", audioModel: store.values.audioModel, audioLanguage: store.values.audioLanguage, audioDiarization: store.values.audioDiarization !== false, microphone: store.values.microphone } : { browserControl: store.values.browserControl, computerControl: store.values.computerControl, questionAutoResolve: store.values.questionAutoResolve !== false })
  onMount(() => {
    void refresh().catch(error => setStore("error", bbError(error)))
    if (props.page === "audio") void loadAudioModels()
    const unsubscribe = api.subscribe(event => { if (event.type === "refresh") void refresh().catch(error => setStore("error", bbError(error))) })
    onCleanup(unsubscribe)
  })
  onCleanup(() => { mounted = false; discovery++ })
  const title = () => bbt(props.page === "audio" ? "audioPage" : "toolsPage")
  return <div class="bb-settings-panel" classList={{ "bb-audio-settings": props.page === "audio", "bb-clean-settings": props.page === "tools" }}>
    <div class="settings-v2-tab-header"><h2 class="settings-v2-tab-title">{title()}</h2></div>
    <div class="settings-v2-tab-body">
      <Show when={store.error}><p class="bb-error" role="alert">{store.error}</p></Show>
      <Show when={store.notice}><p class="bb-subtle" role="status">{store.notice}</p></Show>
      <Show when={store.data}>
        <Show when={props.page === "audio"}>
          <Show when={store.data?.workerError}><p class="bb-error" role="alert">{bbError(store.data?.workerError)}</p></Show>
          <Show when={!store.data?.openrouterSet}><p class="bb-subtle">{bbt("audioConnectProvider")}</p></Show>
            <label data-setting-key="audio-model">{bbt("audioModel")}<select aria-label={bbt("audioModel")} disabled={store.modelsLoading || !!store.busy || store.data?.jobs.some(job => job.recording)} value={store.values.audioModel} onChange={event => void saveAudio({ audioModel: event.currentTarget.value })}>
              <Show when={!store.audioModels.some(model => model.id === store.values.audioModel)}><option value={store.values.audioModel} selected>{store.values.audioModel}</option></Show>
              <For each={store.audioModels}>{model => <option value={model.id} selected={model.id === store.values.audioModel}>{model.name}</option>}</For>
            </select></label>
            <Show when={store.modelsError}><div class="bb-actions"><ButtonV2 variant="neutral" disabled={store.modelsLoading || !!store.busy} onClick={() => void loadAudioModels()}>{bbt("refreshModels")}</ButtonV2></div></Show>
            <Show when={store.modelsError}><p class="bb-error" role="alert">{store.modelsError}</p></Show>
            <Show when={!store.modelsLoading && !store.modelsError && store.audioModels.length && !store.audioModels.some(model => model.id === store.values.audioModel)}><p class="bb-error" role="alert">{bbt("audioModelUnavailable")}</p></Show>
            <label class="bb-check" data-setting-key="audio-diarization" title={bbt(audioSupportsDiarization(store.values.audioModel) ? "audioDiarizationHint" : "audioDiarizationUnavailable")}><input type="checkbox" checked={audioSupportsDiarization(store.values.audioModel) && store.values.audioDiarization !== false} disabled={!audioSupportsDiarization(store.values.audioModel) || !!store.busy || store.data?.jobs.some(job => job.recording)} onChange={event => void saveAudio({ audioDiarization: event.currentTarget.checked })} />{bbt("audioDiarization")}</label>
            <label data-setting-key="audio-language" title={bbt("audioLanguageHint")}>{bbt("audioLanguage")}<input aria-label={bbt("audioLanguage")} maxlength={2} value={store.values.audioLanguage ?? ""} placeholder={bbt("audioAutoLanguage")} disabled={!!store.busy || store.data?.jobs.some(job => job.recording)} onInput={event => setStore("values", "audioLanguage", event.currentTarget.value.trim().toLowerCase())} /></label>
          <label data-setting-key="audio-microphone">{bbt("microphone")}<select disabled={!!store.busy} value={store.values.microphone ?? ""} onChange={event => void saveAudio({ microphone: event.currentTarget.value === "" ? null : Number(event.currentTarget.value) })}><option value="" selected={store.values.microphone == null}>{bbt("systemMicrophone")}</option><For each={store.devices}>{device => <option value={device.id} selected={device.id === store.values.microphone}>{device.name}</option>}</For></select></label>
          <ButtonV2 disabled={!!store.busy} onClick={() => void save()}>{bbt("save")}</ButtonV2>
          <Show when={!store.data?.workerReady || store.data.workerError}><h3 data-setting-key="audio-worker">{bbt("audioComponents")}</h3><p class="bb-subtle">{bbt("audioCloudSetupHint")}</p><ButtonV2 variant="neutral" disabled={!!store.busy} onClick={() => void run("setup", { audioCloud: true })}>{bbt("audioRepairComponents")}</ButtonV2></Show>
        </Show>
          <Show when={props.page === "tools"}>
          <div class="bb-settings-switch-row" data-setting-key="tools-question-timer"><span title={bbt("questionTimerHint")}>{bbt("questionTimer")}</span><input type="checkbox" role="switch" aria-label={bbt("questionTimer")} checked={store.values.questionAutoResolve !== false} onChange={event => setStore("values", "questionAutoResolve", event.currentTarget.checked)} /></div>
          <div class="bb-settings-switch-row" data-setting-key="tools-browser"><span title={bbt("browserHint")}>{bbt("browserControl")}</span><input type="checkbox" role="switch" aria-label={bbt("browserControl")} checked={store.values.browserControl} onChange={event => setStore("values", "browserControl", event.currentTarget.checked)} /></div>
          <div class="bb-settings-switch-row" data-setting-key="tools-computer"><span title={bbt("computerHint")}>{bbt("computerControl")}</span><input type="checkbox" role="switch" aria-label={bbt("computerControl")} checked={store.values.computerControl} onChange={event => setStore("values", "computerControl", event.currentTarget.checked)} /></div>
          <div class="bb-actions"><ButtonV2 disabled={!!store.busy} onClick={() => void save()}>{bbt("save")}</ButtonV2></div>
          <details class="bb-settings-details"><summary>{bbt("extensions.localComponents")}</summary><div class="bb-settings-switch-row" data-setting-key="tools-artifacts"><span title={bbt("artifactsHint")}>{bbt("artifactsRuntime")}</span><ButtonV2 variant="neutral" disabled={!!store.busy} onClick={() => void run("artifact.setup")}>{bbt("installArtifacts")}</ButtonV2></div><ButtonV2 variant="neutral" disabled={!!store.busy} onClick={() => void run("setup", { computer: true })}>{bbt("installComputer")}</ButtonV2></details>
        </Show>
        <Show when={store.busy}><p role="status">{bbt("running")}</p></Show>
      </Show>
    </div>
  </div>
}
