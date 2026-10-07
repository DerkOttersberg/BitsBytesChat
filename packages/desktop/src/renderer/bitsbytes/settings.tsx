import { For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import type { Settings, State } from "../../bitsbytes/types"
import { bbt, bbError } from "../../bitsbytes/copy"

export function BitsBytesSettings(props: { page: "audio" | "tools" | "chatgpt" }) {
  const api = window.api.bitsbytes
  const [store, setStore] = createStore({ data: undefined as State | undefined, values: {} as Settings, devices: [] as { id: number; name: string }[], busy: "", error: "", notice: "", groq: "" })
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
      if (method === "keys.save") setStore("groq", "")
    } catch (error) { setStore("error", bbError(error)) }
    finally { setStore("busy", "") }
  }
  const save = () => run("settings.save", props.page === "audio" ? { engine: store.values.engine, microphone: store.values.microphone, acceleration: store.values.acceleration } : { browserControl: store.values.browserControl, computerControl: store.values.computerControl })
  onMount(() => {
    void refresh().catch(error => setStore("error", bbError(error)))
    const unsubscribe = api.subscribe(event => { if (event.type === "refresh") void refresh().catch(error => setStore("error", bbError(error))) })
    onCleanup(unsubscribe)
  })
  const title = () => bbt(props.page === "audio" ? "audioPage" : props.page === "tools" ? "toolsPage" : "chatgpt")
  return <div class="bb-settings-panel">
    <div class="settings-v2-tab-header"><h2 class="settings-v2-tab-title">{title()}</h2></div>
    <div class="settings-v2-tab-body">
      <Show when={store.error}><p class="bb-error" role="alert">{store.error}</p></Show>
      <Show when={store.notice}><p class="bb-subtle" role="status">{store.notice}</p></Show>
      <Show when={store.data}>
        <Show when={props.page === "chatgpt"}>
          <p>{store.data?.account || bbt("notConnected")}<Show when={store.data?.planVerified}> · {bbt("verified")}</Show></p>
          <div class="bb-actions"><ButtonV2 disabled={!!store.busy} onClick={() => void run("auth.connect")}>{bbt("connect")}</ButtonV2><ButtonV2 variant="neutral" disabled={!!store.busy || !store.data?.account} onClick={() => void run("auth.verify", { refresh: true })}>{bbt("verify")}</ButtonV2><ButtonV2 variant="neutral" onClick={() => void run("usage")}>{bbt("manageUsage")}</ButtonV2><ButtonV2 variant="neutral" disabled={!!store.busy} onClick={() => void run("auth.disconnect")}>{bbt("disconnect")}</ButtonV2></div>
          <div class="bb-actions"><ButtonV2 variant="neutral" disabled={!!store.busy || !store.data?.account} onClick={() => void run("models.list", { provider: "chatgpt", force: true })}>{bbt("refreshModels")}</ButtonV2><span class="bb-subtle">{store.data?.modelsUpdated && !store.data.modelError ? new Date(store.data.modelsUpdated).toLocaleString() : bbt("modelsCached")}</span></div>
          <Show when={store.data?.modelError}><p class="bb-error">{store.data?.modelError}</p></Show>
          <Show when={store.data?.account && store.data.modelsUpdated && !store.data.modelError && !store.data.models.some(model => model.id === "gpt-6.1-sol")}><p class="bb-subtle">{bbt("modelUnavailable")}</p></Show>
        </Show>
        <Show when={props.page === "audio"}>
          <Show when={store.data?.workerError}><p class="bb-error" role="alert">{bbError(store.data?.workerError)}</p></Show>
          <label>{bbt("audioSettings")}<select aria-label={bbt("audioSettings")} disabled={!!store.busy || store.data?.jobs.some(job => job.recording)} value={store.values.engine} onChange={event => setStore("values", "engine", event.currentTarget.value as Settings["engine"])}><option value="parakeet">{bbt("parakeet")}</option><option value="whisper">{bbt("whisper")}</option><option value="groq">{bbt("groq")}</option></select></label>
          <p class="bb-subtle">{bbt(store.values.engine === "groq" ? "onlineHint" : "localHint")}</p>
          <label>{bbt("microphone")}<select value={store.values.microphone ?? ""} onChange={event => setStore("values", "microphone", event.currentTarget.value === "" ? null : Number(event.currentTarget.value))}><option value="">{bbt("systemMicrophone")}</option><For each={store.devices}>{device => <option value={device.id}>{device.name}</option>}</For></select></label>
          <label>{bbt("acceleration")}<select value={store.values.acceleration} onChange={event => setStore("values", "acceleration", event.currentTarget.value as Settings["acceleration"])}><option value="auto">{bbt("automatic")}</option><option value="cpu">{bbt("cpu")}</option></select></label>
          <ButtonV2 disabled={!!store.busy} onClick={() => void save()}>{bbt("save")}</ButtonV2>
          <h3>{bbt("localWorker")}</h3><p class="bb-subtle">{bbt(store.data?.workerReady ? "setupReady" : "setupHint")}</p>
          <div class="bb-actions"><ButtonV2 variant="neutral" disabled={!!store.busy} onClick={() => void run("setup")}>{bbt("setup")}</ButtonV2><ButtonV2 variant="neutral" disabled={!!store.busy || !store.data?.workerReady} onClick={() => void run("model.download", { engine: "parakeet" })}>{bbt("downloadParakeet")}</ButtonV2><ButtonV2 variant="neutral" disabled={!!store.busy || !store.data?.workerReady} onClick={() => void run("model.download", { engine: "whisper" })}>{bbt("downloadWhisper")}</ButtonV2></div>
          <label>{bbt("groqKey")}<input type="password" autocomplete="off" value={store.groq} placeholder={store.data?.groqSet ? bbt("keyStored") : ""} onInput={event => setStore("groq", event.currentTarget.value)} /></label><ButtonV2 variant="neutral" disabled={!!store.busy || !store.groq} onClick={() => void run("keys.save", { groq: store.groq })}>{bbt("saveKeys")}</ButtonV2>
        </Show>
          <Show when={props.page === "tools"}>
            <h3>{bbt("artifactsRuntime")}</h3><p class="bb-subtle">{bbt("artifactsHint")}</p><ButtonV2 disabled={!!store.busy} onClick={() => void run("artifact.setup")}>{bbt("installArtifacts")}</ButtonV2>
          <h3>{bbt("browserControl")}</h3><p class="bb-subtle">{bbt("browserHint")}</p><label class="bb-check"><input type="checkbox" checked={store.values.browserControl} onChange={event => setStore("values", "browserControl", event.currentTarget.checked)} />{bbt("enableBrowser")}</label>
          <h3>{bbt("computerControl")}</h3><p class="bb-subtle">{bbt("computerHint")}</p><label class="bb-check"><input type="checkbox" checked={store.values.computerControl} onChange={event => setStore("values", "computerControl", event.currentTarget.checked)} />{bbt("enable")}</label><div class="bb-actions"><ButtonV2 disabled={!!store.busy} onClick={() => void save()}>{bbt("save")}</ButtonV2><ButtonV2 variant="neutral" disabled={!!store.busy} onClick={() => void run("setup", { computer: true })}>{bbt("installComputer")}</ButtonV2></div>
        </Show>
        <Show when={store.busy}><p role="status">{bbt("running")}</p></Show>
      </Show>
    </div>
  </div>
}
