import { For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import type { CustomMcpEntry, CustomMcpState } from "../../bitsbytes/types"
import { bbt, bbError } from "../../bitsbytes/copy"

export function McpSettings() {
  const [store, setStore] = createStore({
    servers: [] as CustomMcpEntry[],
    name: "",
    original: "",
    config: "",
    busy: false,
    error: "",
    notice: "",
    editing: false,
  })
  const status = (value: string) =>
    bbt(
      value === "connected"
        ? "mcpConnected"
        : value === "disabled"
          ? "mcpDisabled"
          : value === "failed"
            ? "mcpFailed"
            : value === "needs_auth"
              ? "mcpAuth"
              : value === "needs_client_registration"
                ? "mcpRegistration"
                : value === "pending"
                  ? "mcpPending"
                  : "mcpUnknown",
    )
  const refresh = async () => {
    const value = await window.api.bitsbytes.call<CustomMcpState>("mcp.settings.list")
    setStore({
      servers: value.servers,
      error: value.error && !value.servers.some((server) => server.error === value.error) ? bbError(value.error) : "",
    })
  }
  async function run(action: "save" | "remove", server?: CustomMcpEntry) {
    setStore({ busy: true, error: "", notice: "" })
    try {
      const value = await window.api.bitsbytes.call<CustomMcpState>(`mcp.settings.${action}`, {
        name: server?.name ?? store.name,
        ...(action === "save"
          ? { config: server?.config ? JSON.parse(JSON.stringify(server.config)) : JSON.parse(store.config) }
          : {}),
      })
      setStore({
        servers: value.servers,
        error: value.error && !value.servers.some((server) => server.error === value.error) ? bbError(value.error) : "",
        notice: bbt(value.error ? "mcpSavedWarning" : "mcpSaved"),
      })
      if (action === "remove") {
        if (!server || store.original === server.name) setStore({ name: "", original: "", config: "", editing: false })
        return
      }
      if (!server) {
        const saved = value.servers.find((server) => server.name === store.name.trim())
        if (saved?.config)
          setStore({
            name: saved.name,
            original: saved.name,
            config: JSON.stringify(saved.config, null, 2),
            editing: !!value.error,
          })
      }
    } catch (error) {
      setStore("error", error instanceof SyntaxError ? bbt("bb.error.mcpConfig") : bbError(error))
    } finally {
      setStore("busy", false)
    }
  }
  onMount(() => {
    void refresh().catch((error) => setStore("error", bbError(error)))
    const unsubscribe = window.api.bitsbytes.subscribe((event) => {
      if (event.type === "refresh" && !store.busy) void refresh().catch((error) => setStore("error", bbError(error)))
    })
    onCleanup(unsubscribe)
  })
  return (
    <section class="bb-mcp-settings" data-setting-key="tools-mcp">
      <div class="bb-settings-section-heading">
        <span>{bbt("extensions.global")}</span>
        <ButtonV2
          variant="neutral"
          disabled={store.busy}
          onClick={() => setStore({ editing: true, name: "", original: "", config: "", error: "", notice: "" })}
        >
          {bbt("mcpNew")}
        </ButtonV2>
      </div>
      <Show when={store.error}>
        <p class="bb-error" role="alert">
          {store.error}
        </p>
      </Show>
      <Show when={store.servers.length} fallback={<p class="bb-subtle">{bbt("mcpEmpty")}</p>}>
        <For each={store.servers}>
          {(server) => (
            <div class="bb-mcp-server" role="group" aria-label={server.name}>
              <div class="bb-extension-row">
                <span class="bb-extension-label">
                  <Icon name="mcp" size="small" />
                  <strong>{server.name}</strong>
                  <small>{status(server.status)}</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={bbt("extensions.toggle", { name: server.name })}
                  checked={server.config?.enabled !== false}
                  disabled={store.busy || !server.config}
                  onChange={(event) => {
                    const enabled = event.currentTarget.checked
                    event.currentTarget.checked = server.config?.enabled !== false
                    void run("save", {
                      ...server,
                      config: server.config ? { ...server.config, enabled } : undefined,
                    })
                  }}
                />
                <Show
                  when={server.config && server.config.enabled !== false && (server.status === "failed" || server.error)}
                >
                  <ButtonV2
                    variant="ghost-muted"
                    size="small"
                    disabled={store.busy}
                    onClick={() => void run("save", server)}
                  >
                    {bbt("mcpRetry")}
                  </ButtonV2>
                </Show>
                <IconButtonV2
                  class="bb-mcp-edit"
                  variant="ghost-muted"
                  size="small"
                  icon={<Icon name="edit" size="small" />}
                  aria-label={bbt("edit")}
                  title={bbt("edit")}
                  disabled={store.busy}
                  onClick={() =>
                    setStore({
                      name: server.name,
                      original: server.name,
                      config: server.config ? JSON.stringify(server.config, null, 2) : "",
                      error: "",
                      notice: "",
                      editing: true,
                    })
                  }
                />
                <IconButtonV2
                  class="bb-mcp-edit"
                  variant="ghost-muted"
                  size="small"
                  icon={<Icon name="trash" size="small" />}
                  aria-label={bbt("mcpRemove")}
                  title={bbt("mcpRemove")}
                  disabled={store.busy}
                  onClick={() => void run("remove", server)}
                />
              </div>
              <Show when={server.error}>
                {(error) => (
                  <p class="bb-error" role="alert">
                    {bbError(error())}
                  </p>
                )}
              </Show>
            </div>
          )}
        </For>
      </Show>
      <Show when={store.editing}>
        <div class="bb-settings-editor">
          <label>
            {bbt("name")}
            <input
              autocomplete="off"
              value={store.name}
              disabled={store.busy || !!store.original}
              onInput={(event) => setStore("name", event.currentTarget.value)}
            />
          </label>
          <label>
            {bbt("mcpJson")}
            <textarea
              class="bb-code"
              rows="6"
              spellcheck={false}
              value={store.config}
              disabled={store.busy}
              onInput={(event) => setStore("config", event.currentTarget.value)}
            />
          </label>
          <div class="bb-actions">
            <ButtonV2 disabled={store.busy || !store.name.trim() || !store.config.trim()} onClick={() => void run("save")}>
              {bbt("save")}
            </ButtonV2>
            <ButtonV2
              variant="neutral"
              disabled={store.busy}
              onClick={() => setStore({ editing: false, name: "", original: "", config: "" })}
            >
              {bbt("cancel")}
            </ButtonV2>
          </div>
        </div>
      </Show>
    </section>
  )
}
