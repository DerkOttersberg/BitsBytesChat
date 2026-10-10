import { For, Show, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { McpSettings } from "./mcp-settings"
import { SkillsSettings } from "./skills-settings"
import { bbt, bbError } from "../../bitsbytes/copy"

export function ExtensionsSettings() {
  const [store, setStore] = createStore({ tab: "mcp", visited: { mcp: true, plugins: false, skills: false } })
  const select = (tab: "mcp" | "plugins" | "skills") => {
    setStore("visited", tab, true)
    setStore("tab", tab)
  }
  return (
    <div class="bb-settings-panel bb-clean-settings">
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{bbt("extensions.title")}</h2>
      </div>
      <div class="settings-v2-tab-body">
        <div class="bb-settings-subtabs" role="tablist" aria-label={bbt("extensions.title")}>
          <For each={["mcp", "plugins", "skills"] as const}>
            {(tab) => (
              <button
                data-setting-key={`extensions-${tab}-tab`}
                data-setting-reveal
                role="tab"
                aria-selected={store.tab === tab}
                aria-controls={`bb-extension-${tab}`}
                id={`bb-extension-tab-${tab}`}
                onClick={() => select(tab)}
                onKeyDown={(event) => {
                  if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return
                  event.preventDefault()
                  const tabs = ["mcp", "plugins", "skills"] as const
                  const index =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? 2
                        : (tabs.indexOf(store.tab as (typeof tabs)[number]) + (event.key === "ArrowRight" ? 1 : 2)) % 3
                  select(tabs[index])
                  document.getElementById(`bb-extension-tab-${tabs[index]}`)?.focus()
                }}
                tabIndex={store.tab === tab ? 0 : -1}
              >
                {bbt(tab === "mcp" ? "extensions.mcps" : tab === "plugins" ? "extensions.plugins" : "skills")}
              </button>
            )}
          </For>
        </div>
        <For each={["mcp", "plugins", "skills"] as const}>
          {(tab) => (
            <div
              role="tabpanel"
              id={`bb-extension-${tab}`}
              aria-labelledby={`bb-extension-tab-${tab}`}
              hidden={store.tab !== tab}
            >
              <Show when={store.visited[tab]}>
                {tab === "mcp" ? <McpSettings /> : tab === "plugins" ? <PluginsSettings /> : <SkillsSettings />}
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

function PluginsSettings() {
  const [store, setStore] = createStore({
    plugins: [] as { package: string; enabled: boolean }[],
    restartRequired: false,
    pkg: "",
    adding: false,
    busy: false,
    error: "",
  })
  async function run(action: string, args: Record<string, unknown> = {}) {
    setStore({ busy: true, error: "" })
    try {
      const result = await window.api.bitsbytes.call<{ plugins: typeof store.plugins; restartRequired: boolean }>(
        `plugins.settings.${action}`,
        args,
      )
      setStore(result)
      if (action === "save") setStore({ adding: false, pkg: "" })
    } catch (error) {
      setStore("error", bbError(error))
    } finally {
      setStore("busy", false)
    }
  }
  onMount(() => {
    void run("list")
    const unsubscribe = window.api.bitsbytes.subscribe((event) => {
      if (event.type === "refresh" && !store.busy) void run("list")
    })
    onCleanup(unsubscribe)
  })
  return (
    <section data-setting-key="extensions-plugins">
      <div class="bb-settings-section-heading">
        <span>{bbt("extensions.global")}</span>
        <ButtonV2 variant="neutral" disabled={store.busy} onClick={() => setStore("adding", true)}>
          {bbt("extensions.addPlugin")}
        </ButtonV2>
      </div>
      <Show when={store.error}>
        <p class="bb-error" role="alert">
          {store.error}
        </p>
      </Show>
      <Show when={store.restartRequired}>
        <p class="bb-subtle" role="status">
          {bbt("extensions.restart")}
        </p>
      </Show>
      <Show when={store.plugins.length} fallback={<p class="bb-subtle">{bbt("extensions.noPlugins")}</p>}>
        <For each={store.plugins}>
          {(plugin) => (
            <div class="bb-extension-row">
              <span class="bb-extension-label">
                <Icon name="code" size="small" />
                {plugin.package}
              </span>
              <input
                type="checkbox"
                role="switch"
                aria-label={bbt("extensions.toggle", { name: plugin.package })}
                checked={plugin.enabled}
                disabled={store.busy}
                onChange={(event) => {
                  const enabled = event.currentTarget.checked
                  event.currentTarget.checked = plugin.enabled
                  void run("save", { package: plugin.package, enabled })
                }}
              />
              <ButtonV2
                variant="ghost-muted"
                disabled={store.busy}
                onClick={() => void run("remove", { package: plugin.package })}
              >
                {bbt("remove")}
              </ButtonV2>
            </div>
          )}
        </For>
      </Show>
      <Show when={store.adding}>
        <div class="bb-settings-editor">
          <label>
            {bbt("extensions.pluginPackage")}
            <input
              disabled={store.busy}
              aria-label={bbt("extensions.pluginPackage")}
              value={store.pkg}
              onInput={(event) => setStore("pkg", event.currentTarget.value)}
              placeholder="@scope/plugin@version"
            />
          </label>
          <div class="bb-actions">
            <ButtonV2
              disabled={store.busy || !store.pkg.trim()}
              onClick={() => void run("save", { package: store.pkg, enabled: true })}
            >
              {bbt("save")}
            </ButtonV2>
            <ButtonV2 variant="neutral" disabled={store.busy} onClick={() => setStore("adding", false)}>
              {bbt("cancel")}
            </ButtonV2>
          </div>
          <p class="bb-subtle">{bbt("extensions.pluginHint")}</p>
        </div>
      </Show>
    </section>
  )
}
