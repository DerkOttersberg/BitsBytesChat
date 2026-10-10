import { Match, Switch, type JSX } from "solid-js"
import { fileType } from "./file-type"
export { fileType } from "./file-type"
import "./file-type-icon.css"

export function FileTypeIcon(props: { filename: string; kind?: string; class?: string; style?: JSX.CSSProperties }) {
  const type = () => fileType(props.filename, props.kind)
  return (
    <svg class={props.class} style={props.style} data-component="file-type-icon" data-file-type={type()}
      width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.25"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M11.5 2.5H5a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 5 17.5h10a1.5 1.5 0 0 0 1.5-1.5V7.5L11.5 2.5Z" />
      <path d="M11.5 2.5v5h5" />
      <Switch>
        <Match when={type() === "word"}><path d="m6 10.25 1.25 4 1.5-3 1.5 3 1.25-4M13 11h1M13 13.5h1" /></Match>
        <Match when={type() === "spreadsheet"}><rect x="6" y="10" width="8" height="5" rx=".5" /><path d="M10 10v5M6 12.5h8" /></Match>
        <Match when={type() === "presentation"}><rect x="6" y="10" width="8" height="4.5" rx=".5" /><path d="m9 11.25 2 1-2 1v-2ZM10 14.5v1" /></Match>
        <Match when={type() === "code"}><path d="m8 10.5-2 2 2 2m4-4 2 2-2 2m-1.5-4.75-1 5.5" /></Match>
        <Match when={type() === "image"}><circle cx="7.5" cy="10.5" r=".75" /><path d="m6 15 3-3 2 2 1.5-1.5L14 15H6Z" /></Match>
        <Match when={type() === "pdf"}><path d="M6 14.5v-4h1.25a1 1 0 0 1 0 2H6M9.5 10.5v4h.75a1.5 1.5 0 0 0 1.5-1.5v-1a1.5 1.5 0 0 0-1.5-1.5H9.5ZM13 14.5v-4h1.5M13 12.5h1.25" /></Match>
        <Match when={type() === "file"}><path d="M6.5 11h7M6.5 14h5" /></Match>
      </Switch>
    </svg>
  )
}
