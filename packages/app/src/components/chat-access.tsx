import { createEffect, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams, useSearchParams } from "@solidjs/router"
import { usePlatform } from "../context/platform"
import { useSDK } from "../context/sdk"
import { useLanguage } from "../context/language"
import { useLocal } from "../context/local"
import { showToast } from "../utils/toast"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import "./chat-access.css"

export function draftAccessKey(scope: string, directory: string, draft?: string) { return `draft:${scope}:${draft ?? directory}` }

export function ChatAccess() {
  const platform = usePlatform(), sdk = useSDK(), params = useParams(), language = useLanguage(), local = useLocal()
  const [search] = useSearchParams<{ draftId?: string }>()
  const [store, setStore] = createStore({ mode: "ask", busy: false, open: false })
  const identity = () => params.id ?? draftAccessKey(sdk().scope, sdk().directory, search.draftId)
  createEffect(() => {
    const id = identity()
    let active = true
    void platform.bitsbytes?.call<{ mode: string }>("access.get", { sessionID: id }).then(value => { if (active) setStore("mode", value.mode) })
    onCleanup(() => { active = false })
  })
  const unsubscribe = platform.bitsbytes?.subscribe(event => { if (event.type === "access" && event.sessionID === identity() && (event.mode === "ask" || event.mode === "full")) setStore("mode", event.mode) })
  onCleanup(() => unsubscribe?.())
  createEffect(() => {
    const model = local.model.current()
    if (model) void platform.bitsbytes?.call("selection.set", { providerID: model.provider.id, modelID: model.id })
  })
  async function change(mode: string) {
    setStore({ busy: true, open: false })
    try { await platform.bitsbytes?.call("access.set", { sessionID: identity(), mode }); setStore("mode", mode) }
    catch (error) { showToast({ variant: "error", title: language.t("common.requestFailed"), description: String(error) }) }
    finally { setStore("busy", false) }
  }
  return <Show when={platform.bitsbytes}>
    <MenuV2 placement="top-start" gutter={6} open={store.open} onOpenChange={open => setStore("open", open)}>
      <MenuV2.Trigger as={ButtonV2} variant="ghost-muted" size="normal" class="bb-chat-access"
        data-mode={store.mode} aria-label={language.t("bitsbytes.access")} disabled={store.busy}>
        <Show when={store.mode === "full"}><span class="bb-access-warning" aria-hidden="true">!</span></Show>
        <span>{language.t(store.mode === "full" ? "bitsbytes.full" : "bitsbytes.ask")}</span>
        <Icon name="chevron-down" />
      </MenuV2.Trigger>
      <MenuV2.Portal><MenuV2.Content aria-label={language.t("bitsbytes.access")}>
        <MenuV2.RadioGroup value={store.mode} onChange={mode => void change(mode)}>
          <MenuV2.RadioItem value="ask" closeOnSelect>{language.t("bitsbytes.ask")}</MenuV2.RadioItem>
          <MenuV2.RadioItem value="full" closeOnSelect><span class="bb-access-warning" aria-hidden="true">!</span>{language.t("bitsbytes.full")}</MenuV2.RadioItem>
        </MenuV2.RadioGroup>
      </MenuV2.Content></MenuV2.Portal>
    </MenuV2>
  </Show>
}
