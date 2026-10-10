import { Popover } from "@kobalte/core/popover"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import type { Todo } from "@opencode-ai/sdk/v2"
import { Icon } from "@opencode-ai/ui/icon"
import { For, Show, createEffect, createMemo, createUniqueId, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import "./session-todo-widget.css"

export function SessionTodoWidget(props: { todos: Todo[]; sessionID: string }) {
  const language = useLanguage()
  const id = createUniqueId()
  const [store, setStore] = createStore({ open: false, width: 320 })
  const done = createMemo(() => props.todos.filter((todo) => todo.status === "completed").length)
  const active = createMemo(() => props.todos.find((todo) => todo.status === "in_progress"))
  const label = createMemo(() =>
    language.plural("session.todo.widget.progress", props.todos.length, { done: done(), total: props.todos.length }),
  )
  createEffect(() => {
    props.sessionID
    setStore("open", false)
  })
  createEffect(() => {
    if (!props.todos.length) setStore("open", false)
  })
  return (
    <Show when={props.todos.length}>
      <Popover open={store.open} onOpenChange={(open) => setStore("open", open)} placement="bottom-end" gutter={8}>
        <Popover.Trigger
          class="bb-todo-trigger"
          data-component="session-todo-widget"
          aria-label={label()}
          title={active()?.content ?? label()}
          ref={(node) =>
            onMount(() => {
              const chat = node.closest(".bb-workspace-chat, .bb-embedded-chat") ?? node.parentElement
              if (!chat) return
              const update = () => {
                const width = chat.getBoundingClientRect().width
                setStore("width", Math.max(96, Math.min(360, width - 24)))
                if (!width || chat.hasAttribute("inert") || chat.getAttribute("aria-hidden") === "true")
                  setStore("open", false)
              }
              update()
              createResizeObserver(chat, update)
              const observer = new MutationObserver(update)
              observer.observe(chat, { attributes: true, attributeFilter: ["inert", "aria-hidden"] })
              onCleanup(() => observer.disconnect())
            })
          }
        >
          <Icon name="checklist" size="small" />
          <span>
            {done()}/{props.todos.length}
          </span>
          <Icon name="chevron-down" size="small" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content class="bb-todo-popup" style={{ width: `${store.width}px` }} aria-labelledby={id}>
            <div class="bb-todo-heading">
              <Popover.Title id={id}>{language.t("session.todo.widget")}</Popover.Title>
              <Popover.CloseButton aria-label={language.t("common.close")}>
                <Icon name="close" size="small" />
              </Popover.CloseButton>
            </div>
            <div class="bb-todo-progress" role="status">
              {label()}
            </div>
            <div class="bb-todo-track" aria-hidden="true">
              <i style={{ width: `${(100 * done()) / props.todos.length}%` }} />
            </div>
            <ol class="bb-todo-list" tabIndex={0} aria-label={language.t("session.todo.title")}>
              <For each={props.todos}>
                {(todo) => (
                  <li data-status={todo.status}>
                    <span class="bb-todo-marker" aria-hidden="true">
                      <Show
                        when={todo.status === "completed"}
                        fallback={
                          <Show when={todo.status === "cancelled"} fallback={<i />}>
                            <Icon name="close" size="small" />
                          </Show>
                        }
                      >
                        <Icon name="check" size="small" />
                      </Show>
                    </span>
                    <span class="bb-todo-text">
                      {todo.content}
                      <small>{language.t(`session.todo.status.${todo.status}`)}</small>
                    </span>
                  </li>
                )}
              </For>
            </ol>
          </Popover.Content>
        </Popover.Portal>
      </Popover>
    </Show>
  )
}
