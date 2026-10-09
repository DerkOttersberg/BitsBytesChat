import { For, createMemo, createEffect, onCleanup, untrack } from "solid-js"
import type { ChatProject } from "@opencode-ai/schema/chat-project"
import { useSearchParams } from "@solidjs/router"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { useTabs } from "@/context/tabs"
import { useServerSDK } from "@/context/server-sdk"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { createOrganizationClient } from "@/utils/organization-api"
import type { PromptProjectController } from "@/components/prompt-project-selector"
import { createStore } from "solid-js/store"

/** Collection membership is independent of the execution folder. */
export function ChatProjectPicker(props: { folder: PromptProjectController; onDone: () => void }) {
  const tabs = useTabs(),
    sdk = useServerSDK(),
    platform = usePlatform(),
    language = useLanguage()
  const [search] = useSearchParams<{ draftId?: string }>()
  const [state, setState] = createStore({ error: false, projects: [] as ChatProject.Info[] })
  let generation = 0,
    disposed = false
  const draft = createMemo(() => tabs.store.find((tab) => tab.type === "draft" && tab.draftID === search.draftId))
  const refresh = () => {
    const token = ++generation
    return createOrganizationClient(sdk().server.http, platform.fetch)
      .projects()
      .then((projects) => {
        if (!disposed && token === generation) setState({ projects, error: false })
      })
      .catch(() => {
        if (!disposed && token === generation) setState("error", true)
      })
  }
  createEffect(() => {
    sdk().server
    untrack(() => void refresh())
  })
  onCleanup(() => {
    disposed = true
    generation++
  })
  const selected = createMemo(() => {
    const tab = draft()
    return state.projects.find((project) => tab?.type === "draft" && project.id === tab.projectID)
  })
  return (
    <div class="bb-draft-project-controls">
      <MenuV2
        onOpenChange={(open) => {
          if (open) void refresh()
        }}
      >
        <MenuV2.Trigger class="bb-draft-project-picker" aria-label={language.t("organization.selectProject")}>
          <Icon name="folder" size="small" />
          <span>{selected()?.name ?? language.t("organization.unassigned")}</span>
          <Icon name="chevron-down" size="small" />
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content>
            <MenuV2.Item
              onSelect={() => {
                if (search.draftId) tabs.updateDraft(search.draftId, { projectID: undefined })
                props.onDone()
              }}
            >
              {language.t("organization.unassigned")}
            </MenuV2.Item>
            <For each={state.projects}>
              {(project) => (
                <MenuV2.Item
                  onSelect={() => {
                    if (!search.draftId) return
                    tabs.updateDraft(search.draftId, { projectID: project.id })
                    if (project.directory) props.folder.select({ worktree: project.directory })
                    props.onDone()
                  }}
                >
                  <Icon name="folder" size="small" />
                  {project.name}
                </MenuV2.Item>
              )}
            </For>
            <MenuV2.Separator />
            <MenuV2.Item
              onSelect={() =>
                window.dispatchEvent(new CustomEvent("bitsbytes:new-project", { detail: { draftID: search.draftId } }))
              }
            >
              <Icon name="plus-small" size="small" />
              {language.t("organization.newProject")}
            </MenuV2.Item>
            <For each={state.error ? [true] : []}>
              {() => <MenuV2.Item onSelect={() => void refresh()}>{language.t("organization.retry")}</MenuV2.Item>}
            </For>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
      <button
        type="button"
        class="bb-draft-folder-picker"
        title={props.folder.selected()?.worktree}
        onClick={() => props.folder.add()}
      >
        {language.t("organization.workingFolder")}
      </button>
    </div>
  )
}
