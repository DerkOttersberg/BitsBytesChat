import type { JSX } from "solid-js"
import { DockShell, DockTray } from "@opencode-ai/ui/dock-surface"

export function DockPrompt(props: {
  kind: "question" | "permission"
  header: JSX.Element
  children: JSX.Element
  footer: JSX.Element
  ref?: (el: HTMLDivElement) => void
  onKeyDown?: JSX.EventHandlerUnion<HTMLDivElement, KeyboardEvent>
  style?: JSX.CSSProperties
  contentLabel?: string
}) {
  const slot = (name: string) => `${props.kind}-${name}`

  return (
    <div data-component="dock-prompt" data-kind={props.kind} ref={props.ref} style={props.style} onKeyDown={props.onKeyDown}>
      <DockShell data-slot={slot("body")}>
        <div data-slot={slot("header")}>{props.header}</div>
        <div data-slot={slot("content")} tabIndex={props.kind === "permission" ? 0 : undefined} aria-label={props.contentLabel}>{props.children}</div>
      </DockShell>
      <DockTray data-slot={slot("footer")}>{props.footer}</DockTray>
    </div>
  )
}
