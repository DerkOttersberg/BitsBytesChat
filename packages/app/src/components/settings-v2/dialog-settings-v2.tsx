import { Component, createMemo, onCleanup, startTransition, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Dialog } from "@opencode-ai/ui/v2/dialog-v2"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { SettingsGeneralV2 } from "./general"
import { SettingsKeybinds } from "../settings-keybinds"
import { SettingsProvidersV2 } from "./providers"
import { SettingsModelsV2 } from "./models"
import "./settings-v2.css"
import { SettingsServersV2 } from "./servers"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLayout } from "@/context/layout"
import { useTabs } from "@/context/tabs"
import { useServerSync } from "@/context/server-sync"
import { generalSettingsSearch, searchSettings, revealSetting, type SettingsSearchEntry } from "./settings-search"

export const DialogSettings: Component<{
  sessionID?: string
  defaultValue?: string
}> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const layout = useLayout()
  const tabs = useTabs()
  const serverSync = useServerSync()
  const [store, setStore] = createStore({ tab: props.defaultValue ?? "general", search: "" })
  let root: HTMLDivElement | undefined
  let searchInput: HTMLInputElement | undefined
  let reveal: (() => void) | undefined
  let selection = 0
  const categories = createMemo(() => [
    { id: "general", title: language.t("settings.tab.general") },
    { id: "shortcuts", title: language.t("settings.tab.shortcuts") },
    ...(platform.settingsPanels ?? []),
    { id: "servers", title: language.t("status.popover.tab.servers") },
    { id: "providers", title: language.t("settings.providers.title") },
    { id: "models", title: language.t("settings.models.title") },
  ])
  const entries = createMemo<SettingsSearchEntry[]>(() => [
    ...categories().map((category) => ({ id: `category-${category.id}`, tab: category.id, title: category.title })),
    ...generalSettingsSearch(language),
    ...(platform.platform === "desktop"
      ? [
          {
            id: "settings-release-notes",
            tab: "general",
            title: language.t("settings.general.row.releaseNotes.title"),
            description: language.t("settings.general.row.releaseNotes.description"),
            target: "settings-release-notes",
          },
          {
            id: "settings-check-updates",
            tab: "general",
            title: language.t("settings.updates.row.check.title"),
            description: language.t("settings.updates.row.check.description"),
            target: "settings-check-updates",
          },
        ]
      : []),
    ...(platform.getPinchZoomEnabled
      ? [
          {
            id: "settings-pinch-zoom",
            tab: "general",
            title: language.t("settings.general.row.pinchZoom.title"),
            description: language.t("settings.general.row.pinchZoom.description"),
            target: "settings-pinch-zoom",
          },
        ]
      : []),
    ...(platform.bitsbytes
      ? []
      : [
          {
            id: "settings-auto-accept-permissions",
            tab: "general",
            title: language.t("command.permissions.autoaccept.enable"),
            description: language.t("toast.permissions.autoaccept.on.description"),
            target: "settings-auto-accept-permissions",
          },
        ]),
    ...(platform.settingsSearchEntries?.() ?? []),
  ])
  const results = createMemo(() => searchSettings(entries(), store.search))
  const panelStyle = () => ({ display: store.search.trim() ? "none" : undefined })
  const selectResult = (entry: SettingsSearchEntry) => {
    const current = ++selection
    reveal?.()
    setStore({ tab: entry.tab, search: "" })
    queueMicrotask(() => {
      if (!root || current !== selection) return
      if (entry.target) {
        reveal = revealSetting(root, entry.target)
        return
      }
      root
        .querySelector<HTMLElement>('[role="tabpanel"][data-selected] input,[role="tabpanel"][data-selected] button')
        ?.focus()
    })
  }
  const changeSearch = (value: string) => {
    selection++
    reveal?.()
    setStore("search", value)
  }
  const searchEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !store.search || !(event.target instanceof Node) || !root?.contains(event.target))
      return
    // Dialog dismissal also listens on window capture. Claim only this search before that listener.
    event.preventDefault()
    event.stopImmediatePropagation()
    changeSearch("")
    searchInput?.focus()
  }
  window.addEventListener("keydown", searchEscape, true)
  onCleanup(() => {
    window.removeEventListener("keydown", searchEscape, true)
    selection++
    reveal?.()
  })
  const directory = createMemo(() => {
    const route = layout.route()
    if (route.type === "dir-new-sesssion") return route.dir
    if (route.type === "draft") {
      const draft = tabs.store.find((item) => item.type === "draft" && item.draftID === route.draftID)
      return draft?.type === "draft" ? draft.directory : undefined
    }
    if (route.type === "session") return serverSync().session.get(route.sessionId)?.directory
    return undefined
  })

  const showProviders = () => {
    void dialog.show(() => <DialogSettings sessionID={props.sessionID} defaultValue="providers" />)
  }

  return (
    <Dialog size="x-large" variant="settings" class="settings-v2-dialog">
      <div
        class="settings-v2-search-root"
        ref={root}
        onKeyDown={(event) => {
          if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f") return
          event.preventDefault()
          searchInput?.focus()
          searchInput?.select()
        }}
      >
        <TabsV2
          orientation="vertical"
          variant="settings"
          value={store.tab}
          onChange={(value) =>
            void startTransition(() => {
              selection++
              reveal?.()
              setStore({ tab: value, search: "" })
            })
          }
          class="settings-v2"
        >
          <TabsV2.List
            onClick={(event: MouseEvent) => {
              if (!(event.target instanceof Element) || !event.target.closest("button[data-value]")) return
              changeSearch("")
            }}
          >
            <div class="flex flex-col justify-between h-full w-full">
              <div class="flex flex-col gap-3 w-full">
                <div class="settings-v2-search-field">
                  <Icon name="magnifying-glass" size="small" />
                  <input
                    ref={searchInput}
                    type="search"
                    value={store.search}
                    aria-label={language.t("settings.search.placeholder")}
                    placeholder={language.t("settings.search.placeholder")}
                    spellcheck={false}
                    autocomplete="off"
                    onInput={(event) => changeSearch(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown") {
                        event.preventDefault()
                        event.stopPropagation()
                        root?.querySelector<HTMLElement>(".settings-v2-search-result")?.focus()
                      }
                      if (event.key === "Enter" && results()[0]) {
                        event.preventDefault()
                        selectResult(results()[0])
                      }
                    }}
                  />
                  <Show when={store.search}>
                    <button
                      type="button"
                      aria-label={language.t("settings.search.clear")}
                      onClick={() => {
                        changeSearch("")
                        searchInput?.focus()
                      }}
                    >
                      <Icon name="close-small" size="small" />
                    </button>
                  </Show>
                </div>
                <div class="flex flex-col gap-3">
                  <div class="flex flex-col gap-1.5">
                    <TabsV2.SectionTitle>{language.t("settings.section.desktop")}</TabsV2.SectionTitle>
                    <div class="flex flex-col gap-1.5 w-full">
                      <TabsV2.Trigger value="general">
                        <Icon name="sliders" />
                        {language.t("settings.tab.general")}
                      </TabsV2.Trigger>
                      <TabsV2.Trigger value="shortcuts">
                        <Icon name="keyboard" />
                        {language.t("settings.tab.shortcuts")}
                      </TabsV2.Trigger>
                      <For each={platform.settingsPanels}>
                        {(panel) => (
                          <TabsV2.Trigger value={panel.id}>
                            <Icon name="sliders" />
                            {panel.title}
                          </TabsV2.Trigger>
                        )}
                      </For>
                    </div>
                  </div>

                  <div class="flex flex-col gap-1.5">
                    <TabsV2.SectionTitle>{language.t("settings.section.server")}</TabsV2.SectionTitle>
                    <div class="flex flex-col gap-1.5 w-full">
                      <TabsV2.Trigger value="servers">
                        <Icon name="server" />
                        {language.t("status.popover.tab.servers")}
                      </TabsV2.Trigger>
                      <TabsV2.Trigger value="providers">
                        <Icon name="providers" />
                        {language.t("settings.providers.title")}
                      </TabsV2.Trigger>
                      <TabsV2.Trigger value="models">
                        <Icon name="models" />
                        {language.t("settings.models.title")}
                      </TabsV2.Trigger>
                    </div>
                  </div>
                </div>
              </div>
              <div class="settings-v2-nav-footer">
                <span>{platform.applicationName ?? language.t("app.name.desktop")}</span>
                <span>v{platform.version}</span>
              </div>
            </div>
          </TabsV2.List>
          <Show when={store.search.trim()}>
            <section class="settings-v2-panel" aria-label={language.t("settings.search.results")}>
              <div class="settings-v2-tab-header">
                <h2 class="settings-v2-tab-title">{language.t("settings.search.results")}</h2>
              </div>
              <div class="settings-v2-tab-body settings-v2-search-results">
                <p class="settings-v2-search-hint">{language.t("settings.search.hint")}</p>
                <Show
                  when={results().length}
                  fallback={
                    <p role="status" class="settings-v2-search-hint">
                      {language.t("settings.search.empty")}
                    </p>
                  }
                >
                  <For each={results()}>
                    {(entry) => (
                      <button
                        type="button"
                        class="settings-v2-search-result"
                        onClick={() => selectResult(entry)}
                        onKeyDown={(event) => {
                          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
                          event.preventDefault()
                          const buttons = [...root!.querySelectorAll<HTMLButtonElement>(".settings-v2-search-result")]
                          const next = buttons.indexOf(event.currentTarget) + (event.key === "ArrowDown" ? 1 : -1)
                          if (next < 0) {
                            searchInput?.focus()
                            return
                          }
                          buttons[Math.min(buttons.length - 1, next)]?.focus()
                        }}
                      >
                        <span class="settings-v2-search-category">
                          {categories().find((category) => category.id === entry.tab)?.title}
                        </span>
                        <strong>{entry.title}</strong>
                        <Show when={entry.description}>
                          <span class="settings-v2-search-description">{entry.description}</span>
                        </Show>
                      </button>
                    )}
                  </For>
                </Show>
              </div>
            </section>
          </Show>
          <TabsV2.Content value="general" class="settings-v2-panel" style={panelStyle()}>
            <SettingsGeneralV2 sessionID={props.sessionID} />
          </TabsV2.Content>
          <TabsV2.Content value="shortcuts" class="settings-v2-panel" style={panelStyle()}>
            <SettingsKeybinds v2 />
          </TabsV2.Content>
          <TabsV2.Content value="servers" class="settings-v2-panel" style={panelStyle()}>
            <SettingsServersV2 />
          </TabsV2.Content>
          <TabsV2.Content value="providers" class="settings-v2-panel" style={panelStyle()}>
            {platform.providerSettings?.({})}
            <SettingsProvidersV2 directory={directory} onBack={showProviders} />
          </TabsV2.Content>
          <For each={platform.settingsPanels}>
            {(panel) => (
              <TabsV2.Content value={panel.id} class="settings-v2-panel" style={panelStyle()}>
                <panel.component />
              </TabsV2.Content>
            )}
          </For>
          <TabsV2.Content value="models" class="settings-v2-panel" style={panelStyle()}>
            <SettingsModelsV2 />
          </TabsV2.Content>
        </TabsV2>
      </div>
    </Dialog>
  )
}
