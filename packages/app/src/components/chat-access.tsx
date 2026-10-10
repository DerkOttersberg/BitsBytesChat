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

export function draftAccessKey(scope: string, directory: string, draft?: string) {
  return `draft:${scope}:${draft ?? directory}`
}

export function ChatAccess() {
  const platform = usePlatform(),
    sdk = useSDK(),
    params = useParams(),
    language = useLanguage(),
    local = useLocal()
  const [search] = useSearchParams<{ draftId?: string }>()
  const [store, setStore] = createStore({ mode: "ask", busy: false, open: false })
  let revision = 0
  let viewRevision = 0
  const identity = () => params.id ?? draftAccessKey(sdk().scope, sdk().directory, search.draftId)
  createEffect(() => {
    const id = identity()
    viewRevision++
    const token = ++revision
    setStore({ busy: false, open: false, mode: "ask" })
    let active = true
    void platform.bitsbytes
      ?.call<{ mode: string }>("access.get", { sessionID: id })
      .then((value) => {
        if (active && token === revision && ["ask", "auto", "full"].includes(value.mode)) setStore("mode", value.mode)
      })
      .catch((error) => {
        if (active && token === revision)
          showToast({ variant: "error", title: language.t("common.requestFailed"), description: String(error) })
      })
    onCleanup(() => {
      active = false
    })
  })
  const unsubscribe = platform.bitsbytes?.subscribe((event) => {
    if (
      event.type === "access" &&
      event.sessionID === identity() &&
      (event.mode === "ask" || event.mode === "auto" || event.mode === "full")
    ) {
      revision++
      setStore("mode", event.mode)
    }
  })
  onCleanup(() => unsubscribe?.())
  createEffect(() => {
    const model = local.model.current()
    if (model) void platform.bitsbytes?.call("selection.set", { providerID: model.provider.id, modelID: model.id })
  })
  async function change(mode: string) {
    if (store.busy || mode === store.mode || !["ask", "auto", "full"].includes(mode)) return
    const id = identity()
    const view = viewRevision
    revision++
    setStore({ busy: true, open: false })
    try {
      await platform.bitsbytes?.call("access.set", { sessionID: id, mode })
      if (view === viewRevision && identity() === id) setStore("mode", mode)
    } catch (error) {
      if (view === viewRevision && identity() === id)
        showToast({ variant: "error", title: language.t("common.requestFailed"), description: String(error) })
    } finally {
      if (view === viewRevision && identity() === id) setStore("busy", false)
    }
  }
  return (
    <Show when={platform.bitsbytes}>
      <MenuV2 placement="top-start" gutter={6} open={store.open} onOpenChange={(open) => setStore("open", open)}>
        <MenuV2.Trigger
          as={ButtonV2}
          variant="ghost-muted"
          size="normal"
          class="bb-chat-access"
          data-mode={store.mode}
          aria-label={language.t("bitsbytes.access")}
          disabled={store.busy}
        >
          <Show when={store.mode === "full"}>
            <span class="bb-access-warning" aria-hidden="true">
              !
            </span>
          </Show>
          <span>
            {language.t(
              store.mode === "full" ? "bitsbytes.full" : store.mode === "auto" ? "approval.auto" : "bitsbytes.ask",
            )}
          </span>
          <Icon name="chevron-down" />
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content class="bb-access-menu" aria-label={language.t("bitsbytes.access")}>
            <MenuV2.RadioGroup value={store.mode} onChange={(mode) => void change(mode)}>
              <MenuV2.RadioItem value="ask" closeOnSelect>
                <span class="bb-access-option">
                  <span>{language.t("bitsbytes.ask")}</span>
                  <small>{language.t("approval.askHint")}</small>
                </span>
              </MenuV2.RadioItem>
              <MenuV2.RadioItem value="auto" closeOnSelect>
                <span class="bb-access-option">
                  <span>{language.t("approval.auto")}</span>
                  <small>{language.t("approval.autoHint")}</small>
                </span>
              </MenuV2.RadioItem>
              <MenuV2.RadioItem value="full" closeOnSelect>
                <span class="bb-access-warning" aria-hidden="true">
                  !
                </span>
                <span class="bb-access-option">
                  <span>{language.t("bitsbytes.full")}</span>
                  <small>{language.t("approval.fullHint")}</small>
                </span>
              </MenuV2.RadioItem>
            </MenuV2.RadioGroup>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </Show>
  )
}
