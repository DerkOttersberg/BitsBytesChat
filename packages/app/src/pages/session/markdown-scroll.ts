import { createEffect, onCleanup, onMount, type Accessor } from "solid-js"

type Position = { top: number; left: number }
type View = "preview" | "source"

export function useMarkdownScroll(identity: Accessor<string>, roots: Record<View, () => HTMLDivElement>) {
  let key = "", frame = 0
  let positions: Partial<Record<View, Position>> = {}
  const pending = { preview: true, source: true }
  const restore = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      for (const view of ["preview", "source"] as const) {
        const root = roots[view]()
        if (!pending[view] || !root || !root.offsetParent) continue
        const position = positions[view]
        const target = scrollContainer(root)
        target.scrollTop = position?.top ?? 0
        target.scrollLeft = position?.left ?? 0
        if (!position || Math.abs(target.scrollTop - position.top) < 2) pending[view] = false
      }
    })
  }
  createEffect(() => {
    key = "bitsbytes.markdown-scroll:" + identity()
    positions = {}
    try {
      const value = JSON.parse(localStorage.getItem(key) || "{}")
      for (const view of ["preview", "source"] as const) {
        const position = value?.[view]
        if (Number.isFinite(position?.top) && Number.isFinite(position?.left) && position.top >= 0 && position.left >= 0 && position.top < 20_000_000 && position.left < 20_000_000) positions[view] = position
      }
    } catch { /* A damaged preference must not block the document. */ }
    pending.preview = true; pending.source = true
    restore()
  })
  onMount(() => {
    const cleanups = (["preview", "source"] as const).map(view => {
      const root = roots[view]()
      const save = (event: Event) => {
        if (pending[view] || !root.offsetParent) return
        const target = event.composedPath()[0]
        if (!(target instanceof HTMLElement) || target !== scrollContainer(root)) return
        positions[view] = { top: target.scrollTop, left: target.scrollLeft }
        try { localStorage.setItem(key, JSON.stringify(positions)) } catch { /* Optional view state. */ }
      }
      const interact = () => { pending[view] = false }
      root.addEventListener("scroll", save, true)
      root.addEventListener("wheel", interact, { passive: true })
      root.addEventListener("keydown", interact)
      const resize = new ResizeObserver(restore)
      let content: Element | undefined
      const observeContent = () => {
        const next = root.firstElementChild ?? undefined
        if (next === content) return
        if (content) resize.unobserve(content)
        content = next
        if (content) resize.observe(content)
      }
      const mutation = new MutationObserver(() => { observeContent(); restore() })
      mutation.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "style"] })
      resize.observe(root)
      observeContent()
      root.addEventListener("load", restore, true)
      return () => { root.removeEventListener("scroll", save, true); root.removeEventListener("wheel", interact); root.removeEventListener("keydown", interact); root.removeEventListener("load", restore, true); mutation.disconnect(); resize.disconnect() }
    })
    restore()
    onCleanup(() => { cancelAnimationFrame(frame); cleanups.forEach(cleanup => cleanup()) })
  })
}

function scrollContainer(root: HTMLElement): HTMLElement {
  const visit = (element: Element, depth: number): HTMLElement | undefined => {
    if (element instanceof HTMLElement && element.clientHeight && element.scrollHeight > element.clientHeight + 4) return element
    if (depth > 12) return
    for (const child of [...(element.shadowRoot?.children ?? []), ...element.children]) {
      const found = visit(child, depth + 1)
      if (found) return found
    }
  }
  return visit(root, 0) ?? root
}
