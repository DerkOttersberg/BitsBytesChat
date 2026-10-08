import { type ComponentProps } from "solid-js"
import brandMark from "../assets/bitsbytes-logo.png"

// These fallback marks also render before locale/platform providers are ready.
// The product name is intentionally invariant across locales.
const brandName = "Bits & Bytes Chat"

export const Mark = (props: { class?: string }) => (
  <svg data-component="logo-mark" class={props.class} viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg" aria-label={brandName} role="img">
    <image href={brandMark} width="400" height="400" />
  </svg>
)

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => (
  <svg ref={props.ref} data-component="logo-splash" class={props.class} viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg" aria-label={brandName} role="img">
    <image href={brandMark} width="400" height="400" />
  </svg>
)

export const Logo = (props: { class?: string }) => (
  <svg data-component="logo-wordmark" class={props.class} viewBox="0 0 292 54" xmlns="http://www.w3.org/2000/svg" aria-label={brandName} role="img">
    <image href={brandMark} width="54" height="54" />
    <text x="65" y="34" font-family="Segoe UI, system-ui, sans-serif" font-size="23" font-weight="600" fill="var(--text-strong, currentColor)">{brandName}</text>
  </svg>
)
