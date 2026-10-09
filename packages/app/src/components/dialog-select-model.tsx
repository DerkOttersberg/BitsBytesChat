import { usePlatform } from "../context/platform"
import { Popover as Kobalte } from "@kobalte/core/popover"
import { Component, ComponentProps, createEffect, createMemo, For, JSX, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { popularProviders } from "@/hooks/use-providers"
import { Button } from "@opencode-ai/ui/button"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Tag } from "@opencode-ai/ui/tag"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { Tag as TagV2 } from "@opencode-ai/ui/v2/badge-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { ModelTooltip } from "./model-tooltip"
import { useLanguage } from "@/context/language"
import { decode64 } from "@/utils/base64"
import { handleDocumentSearchKeydown } from "@/utils/search-keydown"
import { createMenuDismissController } from "@/utils/menu-dismiss-controller"
import { createEventListener } from "@solid-primitives/event-listener"
import { matchesModelSearch } from "./dialog-select-model-search"

const isFree = (provider: string, cost: { input: number } | undefined) =>
  provider === "opencode" && (!cost || cost.input === 0)

type ModelState = ReturnType<typeof useLocal>["model"]
type ModelItem = ReturnType<ModelState["list"]>[number]

const modelKey = (model: ModelItem) => `${model.provider.id}:${model.id}`
const manageKey = "action:manage"

function showContextWindow(model: ModelState, item: ModelItem, dialog: ReturnType<typeof useDialog>) {
  void dialog.show(() => {
    const language = useLanguage()
    const key = { providerID: item.provider.id, modelID: item.id }
    const choose = (value?: number) => {
      model.context.set(key, value)
      dialog.close()
    }
    return (
      <Dialog title={language.t("contextWindow.title")}>
        <div class="flex flex-col gap-1 px-4 pb-5" data-component="context-window-options">
          <p class="text-13-regular text-text-weak pb-2">{language.t("contextWindow.hint", { model: item.name })}</p>
          <p class="text-12-regular text-text-weak pb-2">{language.t("contextWindow.economyHint")}</p>
          <Button variant="ghost" class="justify-between" onClick={() => choose()}>
            {model.context.recommended(key) ? language.t("contextWindow.recommendedValue", { count: model.context.recommended(key)!.toLocaleString(language.locale()) }) : language.t("contextWindow.recommended")}
            <Show when={model.context.get(key) === undefined}>
              <Icon name="check" size="small" />
            </Show>
          </Button>
          <For each={model.context.list(key)}>
            {(value) => (
              <Button variant="ghost" class="justify-between" onClick={() => choose(value)}>
                {language.t("contextWindow.tokens", { count: value.toLocaleString(language.locale()) })}
                <Show when={model.context.get(key) === value}>
                  <Icon name="check" size="small" />
                </Show>
              </Button>
            )}
          </For>
          <Show when={(model.context.recommended(key) ?? item.limit.context) < item.limit.context}>
            <p class="text-12-regular text-text-weak pt-2">{language.t("contextWindow.expandedHint")}</p>
          </Show>
          <Show when={!model.context.list(key).length}>
            <p class="text-12-regular text-text-weak pt-2">{language.t("contextWindow.unknown")}</p>
          </Show>
        </div>
      </Dialog>
    )
  })
}

const sortModelGroups = (a: { category: string; items: ModelItem[] }, b: { category: string; items: ModelItem[] }) => {
  const aIndex = popularProviders.indexOf(a.category)
  const bIndex = popularProviders.indexOf(b.category)
  const aPopular = aIndex >= 0
  const bPopular = bIndex >= 0

  if (aPopular && !bPopular) return -1
  if (!aPopular && bPopular) return 1
  if (aPopular && bPopular) return aIndex - bIndex
  return a.items[0].provider.name.localeCompare(b.items[0].provider.name)
}

const ModelList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
  action?: JSX.Element
  model?: ModelState
}> = (props) => {
  const model = props.model ?? useLocal().model
  const dialog = useDialog()
  const language = useLanguage()
  void usePlatform()
    .bitsbytes?.call("models.list", { force: false })
    .catch(() => undefined)

  const models = createMemo(() =>
    model
      .list()
      .filter((m) => model.visible({ modelID: m.id, providerID: m.provider.id }))
      .filter((m) => (props.provider ? m.provider.id === props.provider : true)),
  )

  return (
    <List
      class={`flex-1 px-3 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 ${props.class ?? ""}`}
      search={{ placeholder: language.t("dialog.model.search.placeholder"), autofocus: true, action: props.action }}
      emptyMessage={language.t("dialog.model.empty")}
      key={(x) => `${x.provider.id}:${x.id}`}
      items={models}
      current={model.current()}
      filterKeys={["provider.name", "name", "id"]}
      sortBy={(a, b) => a.name.localeCompare(b.name)}
      groupBy={(x) => x.provider.name}
      sortGroupsBy={(a, b) => {
        const aProvider = a.items[0].provider.id
        const bProvider = b.items[0].provider.id
        if (popularProviders.includes(aProvider) && !popularProviders.includes(bProvider)) return -1
        if (!popularProviders.includes(aProvider) && popularProviders.includes(bProvider)) return 1
        return popularProviders.indexOf(aProvider) - popularProviders.indexOf(bProvider)
      }}
      itemWrapper={(item, node) => (
        <Tooltip
          class="w-full"
          placement="right-start"
          gutter={12}
          openDelay={0}
          value={<ModelTooltip model={item} latest={item.latest} free={isFree(item.provider.id, item.cost)} />}
        >
          {node}
        </Tooltip>
      )}
      onSelect={(x) => {
        model.set(x ? { modelID: x.id, providerID: x.provider.id } : undefined, {
          recent: true,
        })
        props.onSelect()
      }}
    >
      {(i) => (
        <div
          class="w-full flex items-center gap-x-2 text-13-regular"
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
            showContextWindow(model, i, dialog)
          }}
        >
          <span class="truncate">{i.name}</span>
          <Show when={isFree(i.provider.id, i.cost)}>
            <Tag>{language.t("model.tag.free")}</Tag>
          </Show>
          <Show when={i.latest}>
            <Tag>{language.t("model.tag.latest")}</Tag>
          </Show>
        </div>
      )}
    </List>
  )
}

type ModelSelectorTriggerProps = Omit<ComponentProps<typeof Kobalte.Trigger>, "as" | "ref">
type ModelSelectorTrigger = (props: ModelSelectorTriggerProps) => JSX.Element
type Dismiss = "escape" | "outside" | "select" | "manage" | "provider"

export function ModelSelectorPopover(props: {
  provider?: string
  model?: ModelState
  trigger: ModelSelectorTrigger
  onClose?: (cause: "escape" | "select") => void
}) {
  const [store, setStore] = createStore<{
    open: boolean
    dismiss: Dismiss | null
  }>({
    open: false,
    dismiss: null,
  })
  const dialog = useDialog()
  const local = useLocal()
  const directory = () => decode64(local.slug())

  const close = (dismiss: Dismiss) => {
    setStore("dismiss", dismiss)
    setStore("open", false)
  }

  const handleManage = () => {
    close("manage")
    void import("./dialog-manage-models").then((x) => {
      dialog.show(() => <x.DialogManageModels />)
    })
  }

  const handleConnectProvider = () => {
    close("provider")
    void import("./dialog-connect-provider").then((x) => {
      void dialog.show(() => <x.DialogConnectProvider directory={directory} />)
    })
  }
  const language = useLanguage()
  void usePlatform()
    .bitsbytes?.call("models.list", { force: false })
    .catch(() => undefined)

  return (
    <Kobalte
      open={store.open}
      onOpenChange={(next) => {
        if (next) setStore("dismiss", null)
        setStore("open", next)
      }}
      modal={false}
      placement="top-start"
      gutter={4}
    >
      <Kobalte.Trigger as={props.trigger} />
      <Kobalte.Portal>
        <Kobalte.Content
          class="w-72 h-80 flex flex-col p-2 rounded-md border border-border-base bg-surface-raised-stronger-non-alpha shadow-md z-50 outline-none overflow-hidden"
          onEscapeKeyDown={(event) => {
            close("escape")
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDownOutside={() => close("outside")}
          onFocusOutside={() => close("outside")}
          onCloseAutoFocus={(event) => {
            const dismiss = store.dismiss
            if (dismiss === "outside") event.preventDefault()
            if (dismiss === "escape" || dismiss === "select") {
              event.preventDefault()
              props.onClose?.(dismiss)
            }
            setStore("dismiss", null)
          }}
        >
          <Kobalte.Title class="sr-only">{language.t("dialog.model.select.title")}</Kobalte.Title>
          <ModelList
            provider={props.provider}
            model={props.model}
            onSelect={() => close("select")}
            class="p-1"
            action={
              <div class="flex items-center gap-1">
                <Tooltip placement="top" value={language.t("command.provider.connect")}>
                  <IconButton
                    icon="plus-small"
                    variant="ghost"
                    iconSize="normal"
                    class="size-6"
                    aria-label={language.t("command.provider.connect")}
                    onClick={handleConnectProvider}
                  />
                </Tooltip>
                <Tooltip placement="top" value={language.t("dialog.model.manage")}>
                  <IconButton
                    icon="sliders"
                    variant="ghost"
                    iconSize="normal"
                    class="size-6"
                    aria-label={language.t("dialog.model.manage")}
                    onClick={handleManage}
                  />
                </Tooltip>
              </div>
            }
          />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}

export function ModelSelectorPopoverV2(props: {
  provider?: string
  model?: ModelState
  trigger: ModelSelectorTrigger
  onClose?: () => void
}) {
  const dialog = useDialog()
  const controller = createModelSelectorController({
    model: props.model,
    provider: () => props.provider,
    onSelect: () => props.onClose?.(),
  })

  return (
    <ModelSelectorPopoverV2View
      trigger={props.trigger}
      models={controller.models}
      groups={controller.groups}
      current={controller.current}
      currentItem={controller.currentItem}
      onContext={(item) => showContextWindow(controller.model, item, dialog)}
      select={controller.select}
      onManage={() => {
        void import("./dialog-manage-models").then((module) => {
          void dialog.show(() => <module.DialogManageModelsV2 />)
        })
      }}
      onClose={() => props.onClose?.()}
    />
  )
}

function createModelSelectorController(input: {
  provider: () => string | undefined
  model?: ModelState
  onSelect: () => void
}) {
  const model = input.model ?? useLocal().model
  const allModels = createMemo(() =>
    model
      .list()
      .filter((item) => model.visible({ modelID: item.id, providerID: item.provider.id }))
      .filter((item) => (input.provider() ? item.provider.id === input.provider() : true)),
  )

  return {
    model,
    currentItem: model.current,
    models: (search: string) => {
      const query = search.trim()
      const filtered = query
        ? allModels().filter((item) => matchesModelSearch(query, [item.name, item.id, item.provider.name]))
        : allModels()
      return [...filtered].sort((a, b) => a.name.localeCompare(b.name))
    },
    groups: (models: ModelItem[]) => {
      const byProvider = new Map<string, ModelItem[]>()
      for (const item of models) {
        byProvider.set(item.provider.id, [...(byProvider.get(item.provider.id) ?? []), item])
      }
      return Array.from(byProvider, ([category, items]) => ({ category, items })).sort(sortModelGroups)
    },
    current: () => {
      const value = model.current()
      return value ? modelKey(value) : undefined
    },
    select: (item: ModelItem) => {
      model.set({ modelID: item.id, providerID: item.provider.id }, { recent: true })
      input.onSelect()
    },
  }
}

function ModelSelectorPopoverV2View(props: {
  trigger: ModelSelectorTrigger
  models: (search: string) => ModelItem[]
  groups: (models: ModelItem[]) => { category: string; items: ModelItem[] }[]
  current: () => string | undefined
  currentItem: () => ModelItem | undefined
  onContext: (item: ModelItem) => void
  select: (item: ModelItem) => void
  onManage: () => void
  onClose: () => void
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({
    open: false,
    search: "",
    active: "",
    catalogError: "",
    catalogLoading: false,
    missingSol: false,
    account: false,
  })
  let searchRef: HTMLInputElement | undefined
  let contentRef: HTMLDivElement | undefined
  const dismiss = createMenuDismissController(() => contentRef)

  const models = createMemo(() => props.models(store.search))
  const groups = createMemo(() => props.groups(models()))
  const keys = () => [...models().map(modelKey), manageKey]
  const initialActive = () => {
    const selected = props.current()
    const options = keys()
    if (selected && options.includes(selected)) return selected
    return options[0] ?? ""
  }
  const activeItem = () =>
    store.active ? contentRef?.querySelector<HTMLElement>(`[data-option-key="${CSS.escape(store.active)}"]`) : undefined
  const bridge = usePlatform().bitsbytes
  async function refreshCatalog(force = false) {
    if (!bridge || store.catalogLoading) return
    setStore("catalogLoading", true)
    try {
      const state = await bridge.call<{ account: string }>("state")
      setStore("account", !!state.account)
      if (!state.account) return
      const models = await bridge.call<{ id: string }[]>("models.list", { provider: "chatgpt", force })
      setStore({ catalogError: "", missingSol: !models.some((model) => model.id === "gpt-6.1-sol") })
    } catch (error) {
      setStore({ catalogError: String(error), missingSol: false })
    } finally {
      setStore("catalogLoading", false)
    }
  }
  const setOpen = (open: boolean) => {
    if (open) {
      void refreshCatalog()
      dismiss.allowTriggerRestore()
      setStore({ open: true, active: initialActive() })
      setTimeout(() =>
        requestAnimationFrame(() => {
          searchRef?.focus()
          activeItem()?.scrollIntoView({ block: "nearest" })
        }),
      )
      return
    }
    setStore({ open: false, search: "", active: "" })
  }
  const selectModel = (item: ModelItem) => {
    dismiss.preventTriggerRestore()
    setOpen(false)
    dismiss.afterClose(() => props.select(item))
  }
  const contextModel = (item?: ModelItem) => {
    if (!item) return
    dismiss.preventTriggerRestore()
    setOpen(false)
    dismiss.afterClose(() => props.onContext(item))
  }
  const manage = () => {
    dismiss.preventTriggerRestore()
    setOpen(false)
    dismiss.afterClose(props.onManage)
  }
  const selectActive = () => {
    const item = models().find((item) => modelKey(item) === store.active)
    if (item) {
      selectModel(item)
      return
    }
    if (store.active === manageKey) manage()
  }
  const moveActive = (delta: number) => {
    const options = keys()
    if (options.length === 0) return
    const index = options.indexOf(store.active)
    const start = index === -1 ? 0 : index
    setStore("active", options[(start + delta + options.length) % options.length])
    queueMicrotask(() => activeItem()?.scrollIntoView({ block: "nearest" }))
  }
  const setSearch = (value: string) => {
    const first = props.models(value)[0]
    setStore({ search: value, active: first ? modelKey(first) : manageKey })
  }

  createEffect(() => {
    if (!store.open) return
    createEventListener(
      document,
      "keydown",
      (event: KeyboardEvent) => {
        if (
          (event.key === "Enter" || event.key === " ") &&
          event.target instanceof Element &&
          event.target.closest('[data-action="model-context-window"]')
        )
          return
        handleDocumentSearchKeydown(searchRef, event, store.search, setSearch)
      },
      true,
    )
  })

  const contextTrigger: ModelSelectorTrigger = (trigger) => (
    <span
      class="contents"
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        contextModel(props.currentItem())
      }}
      onKeyDown={(event) => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault()
          contextModel(props.currentItem())
        }
      }}
    >
      {props.trigger(trigger)}
    </span>
  )

  return (
    <MenuV2 open={store.open} modal={false} placement="top-start" gutter={6} onOpenChange={setOpen}>
      <MenuV2.Trigger as={contextTrigger} />
      <MenuV2.Portal>
        <MenuV2.Content
          ref={(element: HTMLDivElement) => (contentRef = element)}
          class="w-[284px] overflow-hidden rounded-md border-0 bg-v2-background-bg-layer-01 !p-0 shadow-[var(--v2-elevation-floating)] focus:outline-none"
          onPointerDownOutside={dismiss.preventTriggerRestore}
          onFocusOutside={dismiss.preventTriggerRestore}
          onCloseAutoFocus={dismiss.onCloseAutoFocus}
        >
          <div class="flex flex-col p-0.5">
            <div class="flex h-7 items-center gap-2 rounded-sm pl-3 pr-2.5 text-v2-icon-icon-muted">
              <Icon name="magnifying-glass" size="small" class="shrink-0" />
              <input
                ref={(el) => (searchRef = el)}
                value={store.search}
                placeholder={language.t("dialog.model.search.placeholder")}
                class="h-7 min-w-0 flex-1 border-0 bg-transparent text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                onInput={(event) => setSearch(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Tab") return
                  event.stopPropagation()
                  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                    event.preventDefault()
                    contextModel(models().find((item) => modelKey(item) === store.active))
                    return
                  }
                  if (event.key === "Escape") {
                    event.preventDefault()
                    dismiss.preventTriggerRestore()
                    setOpen(false)
                    dismiss.afterClose(props.onClose)
                    return
                  }
                  if (event.altKey || event.metaKey) return
                  if (event.key === "ArrowDown") {
                    event.preventDefault()
                    moveActive(1)
                    return
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault()
                    moveActive(-1)
                    return
                  }
                  if (event.key === "Enter" && !event.isComposing) {
                    event.preventDefault()
                    selectActive()
                  }
                }}
              />
              <Show when={store.search.trim()}>
                <button
                  type="button"
                  class="flex size-5 items-center justify-center rounded-sm text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => setSearch("")}
                  aria-label={language.t("common.clear")}
                >
                  <Icon name="close" size="small" />
                </button>
              </Show>
            </div>
          </div>
          <div class="h-px bg-v2-border-border-muted" />
          <Show when={store.catalogError}>
            <p class="px-3 py-2 text-12-regular text-text-weak" title={store.catalogError}>
              {language.t("bitsbytes.cached")}
            </p>
          </Show>
          <Show when={store.missingSol}>
            <p class="px-3 pt-2 text-12-regular text-text-weak">{language.t("bitsbytes.modelUnavailable")}</p>
          </Show>
          <Show when={store.account}>
            <div class="px-2 py-1">
              <ButtonV2
                variant="ghost-muted"
                size="normal"
                disabled={store.catalogLoading}
                onClick={() => void refreshCatalog(true)}
              >
                {language.t(store.catalogLoading ? "bitsbytes.refreshingModels" : "bitsbytes.refreshModels")}
              </ButtonV2>
            </div>
          </Show>
          <ScrollView data-slot="model-selector-scroll" class="max-h-[220px] min-h-0">
            <div class="flex flex-col p-0.5 pt-0">
              <Show
                when={models().length > 0}
                fallback={
                  <div class="flex h-12 items-center px-3 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-faint">
                    {language.t("dialog.model.empty")}
                  </div>
                }
              >
                <For each={groups()}>
                  {(group) => (
                    <MenuV2.Group>
                      <MenuV2.GroupLabel class="sticky top-0 z-10 gap-2 bg-v2-background-bg-layer-01 px-3">
                        <span class="min-w-0 truncate">{group.items[0].provider.name}</span>
                      </MenuV2.GroupLabel>
                      <MenuV2.RadioGroup value={props.current()}>
                        <For each={group.items}>
                          {(item) => (
                            <TooltipV2
                              class="w-full"
                              placement="right-start"
                              gutter={6}
                              openDelay={0}
                              value={
                                <ModelTooltip
                                  model={item}
                                  latest={item.latest}
                                  free={isFree(item.provider.id, item.cost)}
                                  v2
                                />
                              }
                            >
                              <MenuV2.RadioItem
                                value={modelKey(item)}
                                data-option-key={modelKey(item)}
                                data-selected-model={props.current() === modelKey(item) ? true : undefined}
                                class="scroll-my-6 w-full group"
                                onContextMenu={(event: MouseEvent) => {
                                  event.preventDefault()
                                  event.stopPropagation()
                                  contextModel(item)
                                }}
                                classList={{ "!bg-v2-overlay-simple-overlay-hover": store.active === modelKey(item) }}
                                onMouseEnter={() => {
                                  setStore("active", modelKey(item))
                                  setTimeout(() => searchRef?.focus())
                                }}
                                onSelect={() => selectModel(item)}
                              >
                                <span class="min-w-0 truncate leading-5">{item.name}</span>
                                <Show when={isFree(item.provider.id, item.cost)}>
                                  <TagV2 class="shrink-0">{language.t("model.tag.free")}</TagV2>
                                </Show>
                                <Show when={item.latest}>
                                  <TagV2 class="shrink-0">{language.t("model.tag.latest")}</TagV2>
                                </Show>
                                <button
                                  type="button"
                                  data-action="model-context-window"
                                  class="ml-auto shrink-0 rounded px-1 text-text-weak opacity-0 group-hover:opacity-100 focus:opacity-100"
                                  aria-label={language.t("contextWindow.title")}
                                  title={language.t("contextWindow.title")}
                                  onPointerDown={(event) => event.stopPropagation()}
                                  onPointerUp={(event) => event.stopPropagation()}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter" || event.key === " ") event.stopPropagation()
                                  }}
                                  onClick={(event) => {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    contextModel(item)
                                  }}
                                >
                                  ⋯
                                </button>
                              </MenuV2.RadioItem>
                            </TooltipV2>
                          )}
                        </For>
                      </MenuV2.RadioGroup>
                    </MenuV2.Group>
                  )}
                </For>
              </Show>
            </div>
          </ScrollView>
          <div class="h-px bg-v2-border-border-muted" />
          <div class="flex flex-col p-0.5">
            <MenuV2.Item
              data-option-key={manageKey}
              classList={{ "!bg-v2-overlay-simple-overlay-hover": store.active === manageKey }}
              onMouseEnter={() => {
                setStore("active", manageKey)
                setTimeout(() => searchRef?.focus())
              }}
              onSelect={manage}
            >
              <Icon name="outline-sliders" size="small" />
              <span class="min-w-0 flex-1 truncate leading-5">{language.t("dialog.model.manage")}</span>
            </MenuV2.Item>
          </div>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}

export const DialogSelectModel: Component<{ provider?: string; model?: ModelState }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  void usePlatform()
    .bitsbytes?.call("models.list", { force: false })
    .catch(() => undefined)
  const local = useLocal()
  const directory = () => decode64(local.slug())

  const provider = () => {
    void import("./dialog-connect-provider").then((x) => {
      void dialog.show(() => <x.DialogConnectProvider directory={directory} />)
    })
  }

  const manage = () => {
    void import("./dialog-manage-models").then((x) => {
      dialog.show(() => <x.DialogManageModels />)
    })
  }

  return (
    <Dialog
      title={language.t("dialog.model.select.title")}
      action={
        <Button class="h-7 -my-1 text-14-medium" icon="plus-small" tabIndex={-1} onClick={provider}>
          {language.t("command.provider.connect")}
        </Button>
      }
    >
      <ModelList provider={props.provider} model={props.model} onSelect={() => dialog.close()} />
      <Button variant="ghost" class="ml-3 mt-5 mb-6 text-text-base self-start" onClick={manage}>
        {language.t("dialog.model.manage")}
      </Button>
    </Dialog>
  )
}
