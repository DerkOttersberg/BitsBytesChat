import { For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { ImageProviderState } from "../../bitsbytes/types"
import { bbt, bbError } from "../../bitsbytes/copy"

type Provider = ImageProviderState["provider"] | "none"
export function ImageGenerationSettings() {
  const api = window.api.bitsbytes
  const [store, setStore] = createStore({
    data: undefined as ImageProviderState | undefined,
    provider: "none" as Provider,
    models: [] as { id: string; name: string; editing?: boolean }[],
    model: "",
    saving: false,
    loading: false,
    error: "",
  })
  let disposed = false
  let catalogue = 0
  let intent = 0
  let saving = Promise.resolve()
  const selectedModels: Partial<Record<Exclude<Provider, "none">, string>> = {}
  async function models(provider: Provider) {
    const request = ++catalogue
    setStore({ models: [], loading: provider !== "none" })
    if (provider === "none") return
    try {
      const rows = await api.call<typeof store.models>("images.models", { provider })
      if (!disposed && request === catalogue) setStore("models", rows)
    } catch (error) {
      if (!disposed && request === catalogue) setStore("error", bbError(error))
    } finally {
      if (!disposed && request === catalogue) setStore("loading", false)
    }
  }
  function adopt(data: ImageProviderState) {
    const provider = data.enabled ? data.provider : "none"
    const changed = store.provider !== provider || !store.data
    if (provider !== "none") selectedModels[provider] = data.model
    setStore({ data, provider, model: data.model })
    if (changed) void models(provider)
  }
  async function refresh() {
    const request = intent
    const data = await api.call<ImageProviderState>("images.status")
    if (disposed || request !== intent || store.saving) return
    adopt(data)
  }
  function save(provider: Provider, model?: string) {
    const request = ++intent
    setStore({ saving: true, error: "" })
    saving = saving.catch(() => undefined).then(async () => {
      try {
        const data = await api.call<ImageProviderState>("images.configure", { provider, ...(model ? { model } : {}) })
        if (disposed) return
        if (request === intent) adopt(data)
        else setStore("data", data)
      } catch (error) {
        if (disposed || request !== intent) return
        if (store.data) adopt(store.data)
        setStore("error", bbError(error))
      } finally {
        if (!disposed && request === intent) setStore("saving", false)
      }
    })
  }
  const selectProvider = (provider: Provider) => {
    const model = provider === "none" ? "" : selectedModels[provider] ?? store.data?.connections?.[provider]?.model ?? ""
    setStore({ provider, model })
    void models(provider)
    save(provider, model)
  }
  onMount(() => {
    void refresh().catch((error) => { if (!disposed) setStore("error", bbError(error)) })
    const unsubscribe = api.subscribe((event) => {
      if (event.type === "refresh") void refresh().catch(() => undefined)
    })
    onCleanup(unsubscribe)
  })
  onCleanup(() => { disposed = true; catalogue++ })
  return (
    <div class="bb-settings-panel bb-clean-settings">
      <div class="settings-v2-tab-header"><h2 class="settings-v2-tab-title">{bbt("imageGeneration.title")}</h2></div>
      <div class="settings-v2-tab-body">
        <section data-bb-image-settings data-setting-key="tools-images">
          <label data-setting-key="tools-image-provider">
            {bbt("imageGeneration.provider")}
            <select aria-label={bbt("imageGeneration.provider")} value={store.provider}
              onChange={(event) => selectProvider(event.currentTarget.value as Provider)}>
              <option value="none" selected={store.provider === "none"}>{bbt("imageGeneration.none")}</option>
              <option value="openrouter" selected={store.provider === "openrouter"}>{bbt("imageGeneration.router")}</option>
              <option value="openai" selected={store.provider === "openai"}>{bbt("imageGeneration.openai")}</option>
            </select>
          </label>
          <Show when={store.provider !== "none"}>
            <label data-setting-key="tools-image-model">
              {bbt("imageGeneration.model")}
              <select aria-label={bbt("imageGeneration.model")} value={store.model} disabled={store.loading}
                onChange={(event) => {
                  const model = event.currentTarget.value
                  setStore("model", model)
                  if (store.provider !== "none") selectedModels[store.provider] = model
                  save(store.provider, model)
                }}>
                <option value="" selected={!store.model} disabled>{bbt(store.loading ? "imageGeneration.loadingModels" : "imageGeneration.chooseModel")}</option>
                <Show when={store.model && !store.models.some((row) => row.id === store.model)}><option value={store.model} selected>{store.model}</option></Show>
                <For each={store.models}>{(model) => <option value={model.id} selected={store.model === model.id}>{model.name} · {bbt(model.editing ? "imageGeneration.editing" : "imageGeneration.textOnly")}</option>}</For>
              </select>
            </label>
            <Show when={store.models.find(row => row.id === store.model)?.editing === false}>
              <p class="bb-subtle">{bbt("imageGeneration.textOnlyHint")}</p>
            </Show>
          </Show>
          <Show when={store.saving}><p class="bb-subtle" role="status">{bbt("imageGeneration.saving")}</p></Show>
          <Show when={store.error || store.provider !== "none" && store.data?.error}>
            <p class="bb-error" role="alert">{store.error || bbError(store.data?.error)}</p>
          </Show>
          <Show when={!store.saving && store.provider !== "none" && !store.data?.configured && !store.error}>
            <p class="bb-subtle" role="status">{bbt("imageGeneration.connectProvider", { provider: store.provider === "openai" ? "OpenAI" : "OpenRouter" })}</p>
          </Show>
        </section>
      </div>
    </div>
  )
}
