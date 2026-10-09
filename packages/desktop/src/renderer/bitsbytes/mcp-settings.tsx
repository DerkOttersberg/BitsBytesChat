import { For, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import type { CustomMcpEntry, CustomMcpState } from "../../bitsbytes/types"
import { bbt, bbError } from "../../bitsbytes/copy"

const localExample = { type: "local", command: ["your-mcp-server", "--stdio"], enabled: false, timeout: 10000 }
const remoteExample = { type: "remote", url: "https://example.com/mcp", enabled: false, timeout: 10000 }
export function McpSettings() {
  const [store, setStore] = createStore({
    servers: [] as CustomMcpEntry[],
    name: "",
    original: "",
    config: JSON.stringify(localExample, null, 2),
    busy: false,
    error: "",
    notice: "",
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
    setStore({ servers: value.servers, error: value.error ? bbError(value.error) : "" })
  }
  async function run(action: "save" | "remove") {
    setStore({ busy: true, error: "", notice: "" })
    try {
      const value = await window.api.bitsbytes.call<CustomMcpState>(`mcp.settings.${action}`, {
        name: store.name,
        ...(action === "save" ? { config: JSON.parse(store.config) } : {}),
      })
      setStore({
        servers: value.servers,
        error: value.error ? bbError(value.error) : "",
        notice: bbt(value.error ? "mcpSavedWarning" : "mcpSaved"),
      })
      if (action === "remove") setStore({ name: "", original: "", config: JSON.stringify(localExample, null, 2) })
      else {
        const saved = value.servers.find((server) => server.name === store.name)
        if (saved?.config) setStore({ original: saved.name, config: JSON.stringify(saved.config, null, 2) })
      }
    } catch (error) {
      setStore("error", error instanceof SyntaxError ? bbt("bb.error.mcpConfig") : bbError(error))
    } finally {
      setStore("busy", false)
    }
  }
  onMount(() => void refresh().catch((error) => setStore("error", bbError(error))))
  return (
    <section class="bb-mcp-settings" data-setting-key="tools-mcp">
      <h3>{bbt("mcpTitle")}</h3>
      <p class="bb-subtle">{bbt("mcpHint")}</p>
      <Show when={store.error}>
        <p class="bb-error" role="alert">
          {store.error}
        </p>
      </Show>
      <Show when={store.notice}>
        <p class="bb-subtle" role="status">
          {store.notice}
        </p>
      </Show>
      <Show when={store.servers.length} fallback={<p class="bb-subtle">{bbt("mcpEmpty")}</p>}>
        <For each={store.servers}>
          {(server) => (
            <button
              class="bb-mcp-row"
              disabled={store.busy}
              onClick={() =>
                setStore({
                  name: server.name,
                  original: server.name,
                  config: JSON.stringify(server.config ?? localExample, null, 2),
                  error: server.error ? bbError(server.error) : "",
                  notice: "",
                })
              }
            >
              <strong>{server.name}</strong>
              <span>{status(server.status)}</span>
            </button>
          )}
        </For>
      </Show>
      <div class="bb-actions">
        <ButtonV2
          variant="neutral"
          disabled={store.busy}
          onClick={() =>
            setStore({ name: "", original: "", config: JSON.stringify(localExample, null, 2), error: "", notice: "" })
          }
        >
          {bbt("mcpNew")}
        </ButtonV2>
        <ButtonV2
          variant="neutral"
          disabled={store.busy}
          onClick={() => void refresh().catch((error) => setStore("error", bbError(error)))}
        >
          {bbt("mcpRefresh")}
        </ButtonV2>
      </div>
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
        {bbt("mcpConfig")}
        <textarea
          class="bb-code"
          rows="10"
          spellcheck={false}
          value={store.config}
          disabled={store.busy}
          onInput={(event) => setStore("config", event.currentTarget.value)}
        />
      </label>
      <p class="bb-subtle">{bbt("mcpConfigHint")}</p>
      <div class="bb-actions">
        <ButtonV2
          variant="neutral"
          disabled={store.busy || !!store.original}
          onClick={() => setStore("config", JSON.stringify(localExample, null, 2))}
        >
          {bbt("mcpLocalExample")}
        </ButtonV2>
        <ButtonV2
          variant="neutral"
          disabled={store.busy || !!store.original}
          onClick={() => setStore("config", JSON.stringify(remoteExample, null, 2))}
        >
          {bbt("mcpRemoteExample")}
        </ButtonV2>
        <ButtonV2
          variant="neutral"
          disabled={store.busy || !!store.original}
          onClick={() =>
            setStore({
              name: "Roblox_Studio",
              config: JSON.stringify(
                {
                  type: "local",
                  command: ["cmd.exe", "/c", "%LOCALAPPDATA%\\Roblox\\mcp.bat"],
                  enabled: false,
                  timeout: 60000,
                },
                null,
                2,
              ),
            })
          }
        >
          {bbt("mcpRobloxExample")}
        </ButtonV2>
        <ButtonV2 disabled={store.busy || !store.name.trim()} onClick={() => void run("save")}>
          {bbt("save")}
        </ButtonV2>
        <Show when={store.original}>
          <ButtonV2 variant="neutral" disabled={store.busy} onClick={() => void run("remove")}>
            {bbt("mcpRemove")}
          </ButtonV2>
        </Show>
      </div>
      <p class="bb-subtle">
        {bbt("mcpRobloxHint")}{" "}
        <button
          class="bb-mcp-help"
          onClick={() => void window.api.openExternal("https://create.roblox.com/docs/studio/mcp")}
        >
          {bbt("mcpRoblox")}
        </button>
      </p>
    </section>
  )
}
