import { createEffect, createMemo, on, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { reorderQueuedInput } from "./chat-run-controls"

export function createQueueDrag(input: {
  queue: Accessor<Parameters<typeof reorderQueuedInput>[0]>
  session: Accessor<string>
  commit: (ids: string[]) => Promise<unknown>
}) {
  const visible = createMemo(() => input.queue().filter(row => !row.editing && row.status !== "sending" && row.presentation !== "transcript").map(row => row.id))
  const [state, setState] = createStore({ dragging: "", offset: 0, preview: [] as string[], order: [] as string[], saving: false, landing: "", landingOffset: 0 })
  let pointer: { id: number; row: HTMLElement; list: HTMLElement; source: string; ids: string[]; startY: number; x: number; y: number; scroll: number; top: number; height: number } | undefined
  let frame = 0, request = 0, landingTimer = 0
  const ids = () => state.order.length ? state.order : visible()
  const inside = () => {
    if (!pointer) return false
    const rect = pointer.list.getBoundingClientRect()
    return pointer.x >= rect.left && pointer.x <= rect.right && pointer.y >= rect.top && pointer.y <= rect.bottom
  }
  const release = () => {
    const previous = pointer
    pointer = undefined
    cancelAnimationFrame(frame)
    frame = 0
    document.body.classList.remove("bb-queue-reordering")
    document.removeEventListener("keydown", escape, true)
    window.removeEventListener("blur", cancel)
    if (previous?.row.hasPointerCapture(previous.id)) previous.row.releasePointerCapture(previous.id)
  }
  const cancel = () => {
    if (!pointer) return
    release()
    setState({ dragging: "", offset: 0, preview: [] })
  }
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    event.preventDefault()
    event.stopPropagation()
    cancel()
  }
  const update = () => {
    frame = 0
    if (!pointer || !state.dragging) return
    const rect = pointer.list.getBoundingClientRect()
    // Keep the lifted row inside its own tray, including while it scrolls.
    const scroll = pointer.list.scrollTop - pointer.scroll
    const offset = Math.max(rect.top - pointer.top + scroll, Math.min(rect.bottom - pointer.top - pointer.height + scroll, pointer.y - pointer.startY + scroll))
    setState("offset", offset)
    if (!inside()) return
    const from = pointer.ids.indexOf(pointer.source)
    const to = Math.max(0, Math.min(pointer.ids.length - 1, from + Math.round((pointer.y - pointer.startY + scroll) / pointer.height)))
    const preview = [...pointer.ids]
    preview.splice(to, 0, ...preview.splice(from, 1))
    setState("preview", preview)
    const edge = pointer.y < rect.top + 24 ? -6 : pointer.y > rect.bottom - 24 ? 6 : 0
    if (!edge) return
    const before = pointer.list.scrollTop
    pointer.list.scrollTop += edge
    if (before !== pointer.list.scrollTop) frame = requestAnimationFrame(update)
  }
  createEffect(on(() => [input.session(), visible().join("\0")], (next, previous) => {
    if (!previous || (next[0] === previous[0] && next[1] === previous[1])) return
    cancel()
    setState("order", [])
    if (next[0] !== previous[0]) { request++; clearTimeout(landingTimer); setState({ saving: false, landing: "" }) }
  }))
  onCleanup(() => { request++; clearTimeout(landingTimer); cancel() })
  return {
    state,
    ids,
    start(event: PointerEvent, source: string) {
      if (event.button !== 0 || !event.isPrimary || state.saving || pointer || ids().length < 2) return
      const target = event.target
      if (!(target instanceof Element) || target.closest("button, a, input, [role=menuitem]")) return
      if (event.pointerType === "touch" && !target.closest(".bb-queue-icon")) return
      const row = event.currentTarget as HTMLElement, list = row.closest<HTMLElement>(".bb-queue-list")
      if (!list || !ids().includes(source)) return
      event.preventDefault()
      clearTimeout(landingTimer)
      setState("landing", "")
      const rect = row.getBoundingClientRect()
      pointer = { id: event.pointerId, row, list, source, ids: [...ids()], startY: event.clientY, x: event.clientX, y: event.clientY, scroll: list.scrollTop, top: rect.top, height: rect.height }
      row.setPointerCapture(event.pointerId)
      document.addEventListener("keydown", escape, true)
      window.addEventListener("blur", cancel)
    },
    move(event: PointerEvent) {
      if (!pointer || pointer.id !== event.pointerId) return
      pointer.x = event.clientX
      pointer.y = event.clientY
      if (!state.dragging && Math.abs(pointer.y - pointer.startY) < 4) return
      event.preventDefault()
      if (!state.dragging) {
        setState({ dragging: pointer.source, preview: pointer.ids })
        document.body.classList.add("bb-queue-reordering")
      }
      if (!frame) frame = requestAnimationFrame(update)
    },
    end(event: PointerEvent) {
      if (!pointer || pointer.id !== event.pointerId) return
      pointer.x = event.clientX
      pointer.y = event.clientY
      cancelAnimationFrame(frame)
      update()
      const target = pointer.ids[state.preview.indexOf(pointer.source)]
      const reordered = state.dragging && inside() && target ? reorderQueuedInput(input.queue(), pointer.source, target) : undefined
      const order = [...state.preview]
      const source = pointer.source, landingOffset = state.offset - (order.indexOf(source) - pointer.ids.indexOf(source)) * pointer.height
      release()
      setState({ dragging: "", offset: 0, preview: [] })
      if (!reordered) return
      // Retain the preview until the host acknowledges it, avoiding a snap back.
      const current = ++request
      setState({ order, saving: true, landing: source, landingOffset })
      landingTimer = window.setTimeout(() => setState("landing", ""), 160)
      void input.commit(reordered).catch(() => undefined).finally(() => {
        if (current === request) setState({ order: [], saving: false })
      })
    },
    cancel,
    style(id: string) {
      if (!state.dragging || !pointer) return state.landing === id ? { "--bb-queue-landing-offset": `${state.landingOffset}px` } : undefined
      const offset = id === state.dragging ? state.offset : (state.preview.indexOf(id) - pointer.ids.indexOf(id)) * pointer.height
      return { transform: `translate3d(0, ${offset}px, 0)` }
    },
  }
}
