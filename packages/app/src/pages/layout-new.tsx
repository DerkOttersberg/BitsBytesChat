import { Show, Suspense, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { DebugBar } from "@/components/debug-bar"
import { TabsInfoPopup } from "@/components/help-button"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { usePlatform } from "@/context/platform"
import { ToastRegion } from "@/utils/toast"
import { OrganizationShell } from "./layout/organization-shell"

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const [state, setState] = createStore({ debugTools: true })

  const update: TitlebarUpdate = {
    version: () => {
      const state = platform.updater?.state()
      if (state?.status !== "ready") return
      return state.version
    },
    installing: () => platform.updater?.state().status === "installing",
    install: () => void platform.updater?.install(),
  }

  return (
    <div
      class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      classList={{ "bb-organization-layout": !!platform.bitsbytes }}
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <Titlebar
        update={update}
        debugTools={
          import.meta.env.DEV
            ? { visible: state.debugTools, toggle: () => setState("debugTools", (value) => !value) }
            : undefined
        }
      />
      <main class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict">
        <Show when={platform.bitsbytes} fallback={<Suspense>{props.children}</Suspense>}>
          <OrganizationShell>
            <Suspense>{props.children}</Suspense>
          </OrganizationShell>
        </Show>
      </main>
      {import.meta.env.DEV && state.debugTools && <DebugBar inline />}
      <Show when={!platform.bitsbytes}>
        <TabsInfoPopup />
      </Show>
      <ToastRegion v2 />
    </div>
  )
}
