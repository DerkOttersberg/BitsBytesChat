import { For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import type { ImageProviderState } from "../../bitsbytes/types"
import { bbt, bbError } from "../../bitsbytes/copy"

type TestResult = { job_id: string; status: string; error?: string; capability: ImageProviderState }

export function ImageGenerationSettings() {
  const api = window.api.bitsbytes
  const [store, setStore] = createStore({
    data: undefined as ImageProviderState | undefined,
    model: "",
    key: "",
    busy: false,
    error: "",
    job: "",
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  async function refresh() {
    const data = await api.call<ImageProviderState>("images.status")
    if (disposed) return
    setStore("data", data)
    if (!store.model) setStore("model", data.model)
  }
  async function testResult(result: TestResult) {
    if (disposed) return
    setStore("data", result.capability)
    setStore("job", result.job_id)
    if (result.status === "preparing") {
      timer = setTimeout(() => {
        void api
          .call<TestResult>("images.job", { id: result.job_id })
          .then(testResult)
          .catch((error) => {
            if (!disposed) setStore({ error: bbError(error), busy: false, job: "" })
          })
      }, 1000)
      return
    }
    setStore({ busy: false, job: "", error: result.error ? bbError(result.error) : "" })
  }
  async function run(action: "save" | "verify" | "disconnect") {
    setStore({ busy: true, error: "" })
    try {
      if (action === "verify") {
        await testResult(await api.call<TestResult>("images.verify"))
        return
      }
      const data = await api.call<ImageProviderState>(
        "images.configure",
        action === "disconnect" ? { disconnect: true } : { key: store.key || undefined, model: store.model },
      )
      if (!disposed) setStore({ data, model: data.model, key: "" })
    } catch (error) {
      if (!disposed) setStore({ error: bbError(error), job: "" })
    } finally {
      if (!disposed && !store.job) setStore("busy", false)
    }
  }
  onMount(() => {
    void refresh().catch((error) => setStore("error", bbError(error)))
    const unsubscribe = api.subscribe((event) => {
      if (event.type === "refresh") void refresh().catch(() => undefined)
    })
    onCleanup(unsubscribe)
  })
  onCleanup(() => {
    disposed = true
    clearTimeout(timer)
  })
  return (
    <section data-bb-image-settings data-setting-key="tools-images">
      <h3>{bbt("imageGeneration.title")}</h3>
      <p class="bb-subtle">{bbt("imageGeneration.hint")}</p>
      <Show when={store.error || store.data?.error}>
        <p class="bb-error" role="alert">
          {store.error || bbError(store.data?.error)}
        </p>
      </Show>
      <label data-setting-key="tools-image-key">
        {bbt("imageGeneration.key")}
        <input
          type="password"
          autocomplete="off"
          disabled={store.busy}
          value={store.key}
          placeholder={store.data?.configured ? bbt("keyStored") : ""}
          onInput={(event) => setStore("key", event.currentTarget.value)}
        />
      </label>
      <label data-setting-key="tools-image-model">
        {bbt("imageGeneration.model")}
        <select
          value={store.model}
          disabled={store.busy}
          onChange={(event) => setStore("model", event.currentTarget.value)}
        >
          <For each={store.data?.models ?? []}>{(model) => <option value={model}>{model}</option>}</For>
        </select>
      </label>
      <div class="bb-actions">
        <ButtonV2 disabled={store.busy || (!store.key && !store.data?.configured)} onClick={() => void run("save")}>
          {bbt("imageGeneration.save")}
        </ButtonV2>
        <ButtonV2
          data-setting-key="tools-image-test"
          variant="neutral"
          disabled={store.busy || !store.data?.configured || !!store.key || store.model !== store.data?.model}
          onClick={() => void run("verify")}
        >
          {bbt("imageGeneration.verify")}
        </ButtonV2>
        <ButtonV2
          variant="neutral"
          disabled={store.busy || !store.data?.configured}
          onClick={() => void run("disconnect")}
        >
          {bbt("imageGeneration.disconnect")}
        </ButtonV2>
      </div>
      <p class="bb-subtle">{bbt("imageGeneration.testHint")}</p>
      <p role="status">
        {bbt(
          store.busy && store.job
            ? "imageGeneration.preparing"
            : store.data?.available
              ? "imageGeneration.available"
              : store.data?.configured
                ? "imageGeneration.unverified"
                : "imageGeneration.unavailable",
        )}
      </p>
    </section>
  )
}
