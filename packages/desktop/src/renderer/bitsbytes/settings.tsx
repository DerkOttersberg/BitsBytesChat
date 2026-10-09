import { For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import type { AudioModel, Settings, State } from "../../bitsbytes/types"
import { bbt, bbError } from "../../bitsbytes/copy"
import { McpSettings } from "./mcp-settings"
import { ImageGenerationSettings } from "./image-settings"

export function BitsBytesSettings(props: { page: "audio" | "tools" | "chatgpt" }) {
  const api = window.api.bitsbytes
  const [store, setStore] = createStore({ data: undefined as State | undefined, values: {} as Settings, devices: [] as { id: number; name: string }[], busy: "", error: "", notice: "", openrouterKey: "", audioModels: [] as AudioModel[], modelsLoading: false, modelsError: "" })
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
  async function run(method: string, args: Record<string, unknown> = {}) {
    setStore({ busy: method, error: "", notice: "" })
    try {
      await api.call(method, args)
      await refresh(method === "settings.save")
      if (method === "share.test") setStore("notice", bbt("shareOK"))
      if (method === "models.list") setStore("notice", bbt("modelsUpdated"))
      if (method === "keys.save") setStore("openrouterKey", "")
    } catch (error) { setStore("error", bbError(error)) }
    finally { setStore("busy", "") }
  }
  const save = () => run("settings.save", props.page === "audio" ? { engine: store.values.engine, audioModel: store.values.audioModel, audioLanguage: store.values.audioLanguage, microphone: store.values.microphone, acceleration: store.values.acceleration } : { browserControl: store.values.browserControl, computerControl: store.values.computerControl, questionAutoResolve: store.values.questionAutoResolve !== false })
  onMount(() => {
    void refresh().catch(error => setStore("error", bbError(error)))
    if (props.page === "audio") void loadAudioModels()
    const unsubscribe = api.subscribe(event => { if (event.type === "refresh") void refresh().catch(error => setStore("error", bbError(error))) })
    onCleanup(unsubscribe)
  })
  onCleanup(() => { mounted = false; discovery++ })
  const title = () => bbt(props.page === "audio" ? "audioPage" : props.page === "tools" ? "toolsPage" : "chatgpt")
  return <div class="bb-settings-panel">
    <div class="settings-v2-tab-header"><h2 class="settings-v2-tab-title">{title()}</h2></div>
    <div class="settings-v2-tab-body">
      <Show when={store.error}><p class="bb-error" role="alert">{store.error}</p></Show>
      <Show when={store.notice}><p class="bb-subtle" role="status">{store.notice}</p></Show>
      <Show when={store.data}>
        <Show when={props.page === "chatgpt"}>
          <p>{store.data?.account || bbt("notConnected")}<Show when={store.data?.planVerified}> · {bbt("verified")}</Show></p>
          <div class="bb-actions"><ButtonV2 data-setting-key="chatgpt-connect" disabled={!!store.busy} onClick={() => void run("auth.connect")}>{bbt("connect")}</ButtonV2><ButtonV2 variant="neutral" disabled={!!store.busy || !store.data?.account} onClick={() => void run("auth.verify", { refresh: true })}>{bbt("verify")}</ButtonV2><ButtonV2 data-setting-key="chatgpt-usage" variant="neutral" onClick={() => void run("usage")}>{bbt("manageUsage")}</ButtonV2><ButtonV2 variant="neutral" disabled={!!store.busy} onClick={() => void run("auth.disconnect")}>{bbt("disconnect")}</ButtonV2></div>
          <div class="bb-actions"><ButtonV2 data-setting-key="chatgpt-models" variant="neutral" disabled={!!store.busy || !store.data?.account} onClick={() => void run("models.list", { provider: "chatgpt", force: true })}>{bbt("refreshModels")}</ButtonV2><span class="bb-subtle">{store.data?.modelsUpdated && !store.data.modelError ? new Date(store.data.modelsUpdated).toLocaleString() : bbt("modelsCached")}</span></div>
          <Show when={store.data?.modelError}><p class="bb-error">{store.data?.modelError}</p></Show>
          <Show when={store.data?.account && store.data.modelsUpdated && !store.data.modelError && !store.data.models.some(model => model.id === "gpt-6.1-sol")}><p class="bb-subtle">{bbt("modelUnavailable")}</p></Show>
        </Show>
        <Show when={props.page === "audio"}>
          <Show when={store.data?.workerError}><p class="bb-error" role="alert">{bbError(store.data?.workerError)}</p></Show>
          <label data-setting-key="audio-engine">{bbt("audioSettings")}<select aria-label={bbt("audioSettings")} disabled={!!store.busy || store.data?.jobs.some(job => job.recording)} value={store.values.engine} onChange={event => setStore("values", "engine", event.currentTarget.value as Settings["engine"])}><option value="parakeet">{bbt("parakeet")}</option><option value="whisper">{bbt("whisper")}</option><option value="openrouter">{bbt("openrouterAudio")}</option></select></label>
          <p class="bb-subtle">{bbt(store.values.engine === "openrouter" ? "openrouterAudioHint" : "localHint")}</p>
          <Show when={store.values.engine === "openrouter"}>
            <label data-setting-key="audio-model">{bbt("audioModel")}<select aria-label={bbt("audioModel")} disabled={store.modelsLoading || !!store.busy || store.data?.jobs.some(job => job.recording)} value={store.values.audioModel} onChange={event => setStore("values", "audioModel", event.currentTarget.value)}>
              <Show when={!store.audioModels.some(model => model.id === store.values.audioModel)}><option value={store.values.audioModel}>{store.values.audioModel}</option></Show>
              <For each={store.audioModels}>{model => <option value={model.id}>{model.name}</option>}</For>
            </select></label>
            <p class="bb-subtle">{bbt("audioModelHint")}</p>
            <div class="bb-actions"><ButtonV2 variant="neutral" disabled={store.modelsLoading || !!store.busy} onClick={() => void loadAudioModels()}>{bbt("refreshModels")}</ButtonV2><Show when={store.modelsLoading}><span role="status">{bbt("running")}</span></Show></div>
            <Show when={store.modelsError}><p class="bb-error" role="alert">{store.modelsError}</p></Show>
            <Show when={!store.modelsLoading && !store.modelsError && store.audioModels.length && !store.audioModels.some(model => model.id === store.values.audioModel)}><p class="bb-error" role="alert">{bbt("audioModelUnavailable")}</p></Show>
            <label data-setting-key="audio-language">{bbt("audioLanguage")}<input aria-label={bbt("audioLanguage")} maxlength={2} value={store.values.audioLanguage ?? ""} placeholder={bbt("audioAutoLanguage")} disabled={!!store.busy || store.data?.jobs.some(job => job.recording)} onInput={event => setStore("values", "audioLanguage", event.currentTarget.value.trim().toLowerCase())} /></label><p class="bb-subtle">{bbt("audioLanguageHint")}</p>
          </Show>
          <label data-setting-key="audio-microphone">{bbt("microphone")}<select value={store.values.microphone ?? ""} onChange={event => setStore("values", "microphone", event.currentTarget.value === "" ? null : Number(event.currentTarget.value))}><option value="">{bbt("systemMicrophone")}</option><For each={store.devices}>{device => <option value={device.id}>{device.name}</option>}</For></select></label>
          <Show when={store.values.engine !== "openrouter"}><label data-setting-key="audio-acceleration">{bbt("acceleration")}<select value={store.values.acceleration} onChange={event => setStore("values", "acceleration", event.currentTarget.value as Settings["acceleration"])}><option value="auto">{bbt("automatic")}</option><option value="cpu">{bbt("cpu")}</option></select></label></Show>
          <ButtonV2 disabled={!!store.busy} onClick={() => void save()}>{bbt("save")}</ButtonV2>
          <h3 data-setting-key="audio-worker">{bbt("localWorker")}</h3><p class="bb-subtle">{bbt(store.data?.workerReady ? "setupReady" : store.values.engine === "openrouter" ? "audioCloudSetupHint" : "setupHint")}</p>
          <div class="bb-actions"><ButtonV2 variant="neutral" disabled={!!store.busy} onClick={() => void run("setup", { audioCloud: store.values.engine === "openrouter" })}>{bbt("setup")}</ButtonV2><Show when={store.values.engine !== "openrouter"}><ButtonV2 variant="neutral" disabled={!!store.busy || !store.data?.workerReady} onClick={() => void run("model.download", { engine: "parakeet" })}>{bbt("downloadParakeet")}</ButtonV2><ButtonV2 variant="neutral" disabled={!!store.busy || !store.data?.workerReady} onClick={() => void run("model.download", { engine: "whisper" })}>{bbt("downloadWhisper")}</ButtonV2></Show></div>
          <label data-setting-key="audio-openrouter-key">{bbt("openrouterKey")}<input type="password" autocomplete="off" value={store.openrouterKey} placeholder={store.data?.openrouterSet ? bbt("keyStored") : ""} onInput={event => setStore("openrouterKey", event.currentTarget.value)} /></label><p class="bb-subtle">{bbt("audioKeyHint")}</p><ButtonV2 variant="neutral" disabled={!!store.busy || !store.openrouterKey.trim()} onClick={() => void run("keys.save", { openrouter: store.openrouterKey })}>{bbt("saveKeys")}</ButtonV2>
        </Show>
          <Show when={props.page === "tools"}>
            <McpSettings />
            <ImageGenerationSettings />
            <h3 data-setting-key="tools-question-timer">{bbt("questionTimer")}</h3><p class="bb-subtle">{bbt("questionTimerHint")}</p><label class="bb-check"><input type="checkbox" checked={store.values.questionAutoResolve !== false} onChange={event => setStore("values", "questionAutoResolve", event.currentTarget.checked)} />{bbt("enable")}</label>
            <h3 data-setting-key="tools-artifacts">{bbt("artifactsRuntime")}</h3><p class="bb-subtle">{bbt("artifactsHint")}</p><ButtonV2 disabled={!!store.busy} onClick={() => void run("artifact.setup")}>{bbt("installArtifacts")}</ButtonV2>
          <h3 data-setting-key="tools-browser">{bbt("browserControl")}</h3><p class="bb-subtle">{bbt("browserHint")}</p><label class="bb-check"><input type="checkbox" checked={store.values.browserControl} onChange={event => setStore("values", "browserControl", event.currentTarget.checked)} />{bbt("enableBrowser")}</label>
          <h3 data-setting-key="tools-computer">{bbt("computerControl")}</h3><p class="bb-subtle">{bbt("computerHint")}</p><label class="bb-check"><input type="checkbox" checked={store.values.computerControl} onChange={event => setStore("values", "computerControl", event.currentTarget.checked)} />{bbt("enable")}</label><div class="bb-actions"><ButtonV2 disabled={!!store.busy} onClick={() => void save()}>{bbt("save")}</ButtonV2><ButtonV2 variant="neutral" disabled={!!store.busy} onClick={() => void run("setup", { computer: true })}>{bbt("installComputer")}</ButtonV2></div>
        </Show>
        <Show when={store.busy}><p role="status">{bbt("running")}</p></Show>
      </Show>
    </div>
  </div>
}
