import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist"
import workerURL from "pdfjs-dist/build/pdf.worker.min.mjs?url"
import { bbt, bbError } from "../../bitsbytes/copy"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon } from "@opencode-ai/ui/icon"
GlobalWorkerOptions.workerSrc = workerURL

export function WordPreview(props: { bytes: Uint8Array; close?: () => void }) {
  let canvas!: HTMLCanvasElement
  let paper!: HTMLDivElement
  const [page, setPage] = createSignal(1)
  const [pages, setPages] = createSignal(0)
  const [zoom, setZoom] = createSignal(1)
  const [error, setError] = createSignal("")
  const [width, setWidth] = createSignal(0)
  onMount(() => {
    const observer = new ResizeObserver(() => setWidth(paper.clientWidth))
    observer.observe(paper)
    onCleanup(() => observer.disconnect())
  })
  const [document, setDocument] = createSignal<Awaited<ReturnType<typeof getDocument>["promise"]>>()
  let rendering: { cancel: () => void; promise: Promise<void> } | undefined
  createEffect(() => {
    const load = getDocument({ data: props.bytes.slice() })
    void load.promise.then((pdf) => { setDocument(pdf); setPages(pdf.numPages); setPage(1) }).catch((reason) => setError(bbError(reason)))
    onCleanup(() => { rendering?.cancel(); void load.destroy() })
  })
  createEffect(() => {
    const pdf = document()
    const index = page()
    const scale = zoom()
    const available = width()
    if (!pdf || available < 64) return
    let current = true
    rendering?.cancel()
    void pdf.getPage(index).then(async (sheet) => {
      if (!current) return
      const base = sheet.getViewport({ scale: 1 })
      const viewport = sheet.getViewport({ scale: ((available - 32) / base.width) * scale })
      const pixel = window.devicePixelRatio || 1
      canvas.width = viewport.width * pixel
      canvas.height = viewport.height * pixel
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      rendering = sheet.render({ canvas, viewport, transform: pixel === 1 ? undefined : [pixel, 0, 0, pixel, 0, 0] })
      await rendering.promise.catch((reason) => { if (reason.name !== "RenderingCancelledException") setError(bbError(reason)) })
    }).catch((reason) => setError(bbError(reason)))
    onCleanup(() => { current = false; rendering?.cancel() })
  })
  return <aside class="bb-preview">
    <Show when={props.close}><header><strong>{bbt("preview")}</strong><button aria-label={bbt("closePreview")} onClick={props.close}>×</button></header></Show>
    <div class="bb-preview-controls">
      <div class="bb-preview-control-group">
        <IconButtonV2 variant="ghost-muted" size="normal" icon={<Icon name="chevron-left" />} aria-label={bbt("previousPage")} title={bbt("previousPage")} disabled={page() <= 1} onClick={() => setPage(page() - 1)} />
        <span class="bb-preview-page">{bbt("page")} {page()} / {pages()}</span>
        <IconButtonV2 variant="ghost-muted" size="normal" icon={<Icon name="chevron-right" />} aria-label={bbt("nextPage")} title={bbt("nextPage")} disabled={page() >= pages()} onClick={() => setPage(page() + 1)} />
      </div>
      <div class="bb-preview-control-group" role="group" aria-label={bbt("zoom")}>
        <IconButtonV2 variant="ghost-muted" size="normal" icon={<span aria-hidden="true">−</span>} aria-label={bbt("zoomOut")} title={bbt("zoomOut")} disabled={zoom() <= .5} onClick={() => setZoom(value => Math.max(.5, value - .25))} />
        <ButtonV2 variant="ghost-muted" size="normal" aria-pressed={zoom() === 1} onClick={() => setZoom(1)}>{bbt("fit")}</ButtonV2>
        <IconButtonV2 variant="ghost-muted" size="normal" icon={<Icon name="plus-small" />} aria-label={bbt("zoomIn")} title={bbt("zoomIn")} disabled={zoom() >= 3} onClick={() => setZoom(value => Math.min(3, value + .25))} />
      </div>
    </div>
    <Show when={error()}><p class="bb-error">{error()}</p></Show>
    <div class="bb-paper" ref={paper}><canvas ref={canvas} /></div>
  </aside>
}
