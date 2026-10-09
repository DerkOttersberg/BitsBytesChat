import fuzzysort from "fuzzysort"
import type { useLanguage } from "@/context/language"

export type SettingsSearchEntry = {
  id: string
  tab: string
  title: string
  description?: string
  target?: string
}

export function generalSettingsSearch(language: ReturnType<typeof useLanguage>) {
  const rows = [
    ["settings.general.row.language", "settings-language"],
    ["settings.general.row.shell", "settings-shell"],
    ["settings.general.row.reasoningSummaries", "settings-feed-reasoning-summaries"],
    ["settings.general.row.shellToolPartsExpanded", "settings-feed-shell-tool-parts-expanded"],
    ["settings.general.row.editToolPartsExpanded", "settings-feed-edit-tool-parts-expanded"],
    ["settings.general.row.colorScheme", "settings-color-scheme"],
    ["settings.general.row.theme", "settings-theme"],
    ["settings.general.row.uiFont", "settings-ui-font"],
    ["settings.general.row.font", "settings-code-font"],
    ["settings.general.row.terminalFont", "settings-terminal-font"],
    ["settings.general.notifications.agent", "settings-notifications-agent"],
    ["settings.general.notifications.permissions", "settings-notifications-permissions"],
    ["settings.general.notifications.errors", "settings-notifications-errors"],
    ["settings.general.sounds.agent", "settings-sounds-agent"],
    ["settings.general.sounds.permissions", "settings-sounds-permissions"],
    ["settings.general.sounds.errors", "settings-sounds-errors"],
    ["settings.general.row.showFileTree", "settings-show-file-tree"],
    ["settings.general.row.showSearch", "settings-show-search"],
    ["settings.general.row.showStatus", "settings-show-status"],
    ["settings.general.row.showCustomAgents", "settings-show-custom-agents"],
  ] as const
  return rows.map(([key, target]) => ({
    id: target,
    tab: "general",
    title: language.t(`${key}.title`),
    description: language.t(`${key}.description`),
    target,
  }))
}

export function searchSettings(entries: readonly SettingsSearchEntry[], query: string) {
  if (!query.trim()) return []
  return fuzzysort
    .go(query.trim(), entries, { keys: ["title", "description"], threshold: 0.25, limit: 50 })
    .map((result) => result.obj)
}

/** Wait for a lazily loaded native settings panel; never mount it just to build the index. */
export function revealSetting(root: HTMLElement, target: string) {
  let selected: HTMLElement | undefined
  let highlight: ReturnType<typeof setTimeout> | undefined
  const observer = new MutationObserver(() => inspect())
  const timeout = setTimeout(() => observer.disconnect(), 5000)
  const inspect = () => {
    const anchor = [...root.querySelectorAll<HTMLElement>("[data-action],[data-setting-key]")].find(
      (item) => item.dataset.action === target || item.dataset.settingKey === target,
    )
    if (!anchor) return
    observer.disconnect()
    clearTimeout(timeout)
    selected = anchor.closest<HTMLElement>('[data-component="settings-v2-row"],label,section') ?? anchor
    selected.classList.add("settings-v2-search-highlight")
    selected.scrollIntoView?.({ block: "center", behavior: "auto" })
    const control = anchor.matches("input,button,select,textarea")
      ? anchor
      : selected.querySelector<HTMLElement>(
          "input:not([disabled]),button:not([disabled]),select:not([disabled]),textarea:not([disabled])",
        )
    control?.focus({ preventScroll: true })
    highlight = setTimeout(() => selected?.classList.remove("settings-v2-search-highlight"), 2500)
  }
  observer.observe(root, { subtree: true, childList: true })
  inspect()
  return () => {
    observer.disconnect()
    clearTimeout(timeout)
    clearTimeout(highlight)
    selected?.classList.remove("settings-v2-search-highlight")
  }
}
