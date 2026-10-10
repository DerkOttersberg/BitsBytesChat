import { type ComponentProps, createMemo, Show, splitProps } from "solid-js"
import { createStore } from "solid-js/store"
import { Card, CardDescription } from "@opencode-ai/ui/card"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { toolPresentationKey } from "./tool-presentation"
import { ToolDetails } from "./tool-details"

export interface ToolErrorCardProps extends Omit<ComponentProps<typeof Card>, "children" | "variant"> {
  tool: string
  error: string
  input?: unknown
  title?: string
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  subtitle?: string
  href?: string
  onSubtitleClick?: (event: MouseEvent) => void
}

export function ToolErrorCard(props: ToolErrorCardProps) {
  const i18n = useI18n()
  const [state, setState] = createStore({
    open: props.defaultOpen ?? false,
    copied: false,
  })
  const open = () => props.open ?? state.open
  const copied = () => state.copied
  const [split, rest] = splitProps(props, [
    "tool",
    "error",
    "input",
    "title",
    "defaultOpen",
    "open",
    "onOpenChange",
    "subtitle",
    "href",
    "onSubtitleClick",
  ])
  const setOpen = (value: boolean) => {
    if (props.open === undefined) setState("open", value)
    props.onOpenChange?.(value)
  }
  const name = createMemo(() => {
    if (split.title) return split.title
    const presentation = toolPresentationKey(split.tool)
    if (presentation) return i18n.t(presentation)
    const map: Record<string, string> = {
      read: "ui.tool.read",
      list: "ui.tool.list",
      glob: "ui.tool.glob",
      grep: "ui.tool.grep",
      task: "ui.tool.task",
      webfetch: "ui.tool.webfetch",
      websearch: "ui.tool.websearch",
      bash: "ui.tool.shell",
      shell: "ui.tool.shell",
      patch: "ui.tool.patch",
      apply_patch: "ui.tool.patch",
      question: "ui.tool.questions",
    }
    const key = map[split.tool]
    if (!key) return i18n.t("ui.tool.generic")
    if (!key.includes(".")) return key
    return i18n.t(key)
  })
  const cleaned = createMemo(() => split.error.replace(/^Error:\s*/, "").trim())
  const tail = createMemo(() => {
    const value = cleaned()
    const prefix = `${split.tool} `
    if (value.startsWith(prefix)) return value.slice(prefix.length)
    return value
  })

  const subtitle = createMemo(() => {
    if (split.subtitle) return split.subtitle
    return i18n.t(
      split.tool === "webfetch" && /\b(404|410)\b/.test(cleaned())
        ? "ui.toolErrorCard.pageUnavailable"
        : "ui.toolErrorCard.unsuccessful",
    )
  })

  const body = createMemo(() => {
    const parts = tail().split(": ")
    if (parts.length <= 1) return cleaned()
    return parts.slice(1).join(": ").trim() || cleaned()
  })

  const copy = async () => {
    const text = cleaned()
    if (!text) return
    await navigator.clipboard.writeText(text)
    setState("copied", true)
    setTimeout(() => setState("copied", false), 2000)
  }

  return (
    <Card {...rest} data-kind="tool-error-card" data-open={open() ? "true" : "false"}>
      <Collapsible class="tool-collapsible" data-open={open() ? "true" : "false"} open={open()} onOpenChange={setOpen}>
        <Collapsible.Trigger>
          <div data-component="tool-trigger">
            <div data-slot="basic-tool-tool-trigger-content">
              <span data-slot="basic-tool-tool-indicator" data-component="tool-error-card-icon">
                <Icon name="warning" size="small" style={{ "stroke-width": 1.5 }} />
              </span>
              <div data-slot="basic-tool-tool-info">
                <div data-slot="basic-tool-tool-info-structured">
                  <div data-slot="basic-tool-tool-info-main">
                    <span data-slot="basic-tool-tool-title">{name()}</span>
                    <Show
                      when={split.href && split.subtitle}
                      fallback={<span data-slot="basic-tool-tool-subtitle">{subtitle()}</span>}
                    >
                      <a
                        data-slot="basic-tool-tool-subtitle"
                        class="clickable subagent-link"
                        href={split.href!}
                        onClick={(event) => {
                          event.stopPropagation()
                          split.onSubtitleClick?.(event)
                        }}
                      >
                        {subtitle()}
                      </a>
                    </Show>
                  </div>
                </div>
              </div>
            </div>
            <Collapsible.Arrow />
          </div>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div data-slot="tool-error-card-content">
            <Show when={open()}>
              <div data-slot="tool-error-card-copy">
                <Tooltip
                  value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.toolErrorCard.copyError")}
                  placement="top"
                  gutter={4}
                >
                  <IconButton
                    icon={copied() ? "check" : "copy"}
                    size="normal"
                    variant="ghost"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation()
                      void copy()
                    }}
                    aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.toolErrorCard.copyError")}
                  />
                </Tooltip>
              </div>
            </Show>
            <Show when={body()}>{(value) => <CardDescription>{value()}</CardDescription>}</Show>
            <Show when={open()}>
              <ToolDetails tool={split.tool} input={split.input} error={split.error} />
            </Show>
          </div>
        </Collapsible.Content>
      </Collapsible>
    </Card>
  )
}
