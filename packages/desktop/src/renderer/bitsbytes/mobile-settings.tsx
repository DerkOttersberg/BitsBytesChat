import { For, Show, createMemo, onMount, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { mobileCopy } from "../../bitsbytes/mobile-copy"
import qrcode from "../../../resources/bitsbytes/mobile/vendor/qrcode.js"

type State = {
  enabled: boolean
  port: number
  error: string
  fingerprint: string
  urls: string[]
  addresses: { name: string; url: string; kind: "lan" | "other" }[]
  preferredURL: string
  devices: { id: string; name: string; seen: number }[]
  requests: { id: string; name: string }[]
}
export function MobileSettings() {
  const api = window.api.bitsbytes,
    copy = mobileCopy
  const [store, setStore] = createStore({
    state: undefined as State | undefined,
    port: 24483,
    url: "",
    token: "",
    address: "",
    qr: "",
    busy: false,
    error: "",
    copied: false,
  })
  const refresh = async () => {
    try {
      const state = await api.call<State>("mobile.state")
      if (!store.state) setStore("port", state.port)
      setStore("state", state)
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : copy.error)
    }
  }
  async function action(name: string, args: Record<string, unknown> = {}) {
    setStore({ busy: true, error: "" })
    try {
      const state = await api.call<State & { token?: string }>("mobile." + name, args)
      setStore("state", state)
      if (state.token) {
        setStore({ token: state.token, address: state.preferredURL, copied: false })
        updateQR(state.preferredURL, state.token)
      }
      if (name === "disable") setStore({ qr: "", url: "", token: "" })
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : copy.error)
    } finally {
      setStore("busy", false)
    }
  }
  function updateQR(address: string, token: string) {
    const url = address ? `${address}/#pair=${token}` : ""
    if (!url) {
      setStore({ qr: "", url: "" })
      return
    }
    const qr = qrcode(0, "M")
    qr.addData(url)
    qr.make()
    setStore({ qr: qr.createDataURL(5, 16), url })
  }
  onMount(() => {
    void refresh()
    const unsubscribe = api.subscribe((event) => {
      if (event.type === "refresh") void refresh()
    })
    const timer = setInterval(() => {
      if (store.state?.enabled) void refresh()
    }, 3000)
    onCleanup(() => {
      unsubscribe()
      clearInterval(timer)
    })
  })
  return (
    <div class="bb-settings-panel">
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{copy.title}</h2>
      </div>
      <div class="settings-v2-tab-body">
        <p class="bb-subtle">{copy.hint}</p>
        <Show when={store.error || store.state?.error}>
          <p class="bb-error" role="alert">
            {store.error || store.state?.error}
          </p>
        </Show>
        <div class="bb-actions">
          <ButtonV2
            disabled={store.busy}
            onClick={() => void action(store.state?.enabled ? "disable" : "enable", { port: store.port })}
          >
            {store.state?.enabled ? copy.disable : copy.enable}
          </ButtonV2>
          <span class="bb-subtle">{store.state?.enabled ? copy.enabled : copy.disabled}</span>
        </div>
        <Show when={!store.state?.enabled}>
          <label>
            {copy.port}
            <input
              type="number"
              min="1024"
              max="65535"
              value={store.port}
              onInput={(event) => setStore("port", Number(event.currentTarget.value))}
            />
          </label>
        </Show>
        <Show when={store.state?.enabled}>
          <p class="bb-subtle">{copy.tlsHint}</p>
          <p class="bb-subtle">{copy.firewall}</p>
          <label>
            {copy.fingerprint}
            <code style={{ "overflow-wrap": "anywhere", "font-size": "12px" }}>{store.state?.fingerprint}</code>
          </label>
          <Show when={store.state?.urls.length} fallback={<p>{copy.noAddresses}</p>}>
            <ButtonV2 disabled={store.busy} onClick={() => void action("pair")}>
              {copy.pair}
            </ButtonV2>
          </Show>
          <Show when={store.qr}>
            <label>
              {copy.addresses}
              <select
                aria-label={copy.addresses}
                disabled={store.busy}
                value={store.address}
                onChange={(event) => {
                  setStore("address", event.currentTarget.value)
                  updateQR(event.currentTarget.value, store.token)
                  void action("address", { url: event.currentTarget.value })
                }}
              >
                <For each={store.state?.urls}>{(url) => {
                  // Keep option identities stable across the settings' periodic refresh.
                  const row = createMemo(() => store.state?.addresses.find((item) => item.url === url))
                  return (
                    <option value={url}>
                      {row()?.name} · {url}{row()?.kind === "other" ? ` · ${copy.otherNetwork}` : ""}
                    </option>
                  )
                }}</For>
              </select>
            </label>
            <p class="bb-subtle">{copy.addressHint}</p>
            <img
              src={store.qr}
              width="240"
              height="240"
              alt={copy.pair}
              style={{ "border-radius": "12px", background: "white", "object-fit": "contain" }}
            />
            <p class="bb-subtle">{copy.expires}</p>
            <code style={{ "overflow-wrap": "anywhere" }}>{store.url}</code>
            <div class="bb-actions">
              <ButtonV2
                variant="neutral"
                onClick={() => void navigator.clipboard.writeText(store.url).then(() => setStore("copied", true))}
              >
                {store.copied ? copy.copied : copy.copy}
              </ButtonV2>
            </div>
          </Show>
          <Show when={store.state?.requests.length}>
            <h3>{copy.requests}</h3>
            <For each={store.state?.requests}>
              {(request) => (
                <div class="bb-actions">
                  <span>{request.name}</span>
                  <ButtonV2 onClick={() => void action("approve", { id: request.id })}>{copy.approve}</ButtonV2>
                  <ButtonV2 variant="neutral" onClick={() => void action("reject", { id: request.id })}>
                    {copy.reject}
                  </ButtonV2>
                </div>
              )}
            </For>
          </Show>
          <h3>{copy.devices}</h3>
          <Show when={store.state?.devices.length} fallback={<p class="bb-subtle">{copy.noDevices}</p>}>
            <For each={store.state?.devices}>
              {(device) => (
                <div class="bb-actions">
                  <span>{device.name}</span>
                  <ButtonV2 variant="neutral" onClick={() => void action("revoke", { id: device.id })}>
                    {copy.revoke}
                  </ButtonV2>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  )
}
