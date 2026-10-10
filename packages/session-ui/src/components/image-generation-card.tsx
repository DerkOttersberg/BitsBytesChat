import { createEffect, createMemo, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { Icon } from "@opencode-ai/ui/icon"
import { ImagePreview } from "@opencode-ai/ui/image-preview"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { useData } from "../context"
import { ownsPart } from "./execution-activity"
import { isImageGenerationTool } from "./tool-presentation"
import { createImageContent } from "./image-content"
import "./image-generation-card.css"

export type ImageArtifact = {
  id: string
  sessionID: string
  filename: string
  revision: number
  image?: { jobID: string }
}
type ImageJob = {
  job_id: string
  sessionID: string
  inputID?: string
  callID?: string
  created: number
  updated?: number
  status: "preparing" | "ready" | "error" | "canceled" | "uncertain"
  artifact?: ImageArtifact
  error?: string
}
type ImageRow = {
  key: string
  status: ImageJob["status"] | "waiting" | "loading"
  artifact?: ImageArtifact
  error?: string
}

function imageToolJobID(part: ToolPart) {
  if (typeof part.state.input.job_id === "string") return part.state.input.job_id
  if (part.state.status !== "completed") return
  try {
    const value: unknown = JSON.parse(part.state.output)
    if (value && typeof value === "object" && "job_id" in value && typeof value.job_id === "string") return value.job_id
  } catch {
    // Non-image Code Mode output is left to the normal tool transcript.
  }
}

export function ImageGenerationGallery(props: {
  sessionID: string
  inputIDs: string[]
  tools: ToolPart[]
  artifacts: ImageArtifact[]
}) {
  const data = useData()
  const [store, setStore] = createStore({ jobs: [] as ImageJob[], hydrated: false })
  const imageTools = createMemo(() =>
    props.tools.filter(
      (part) =>
        isImageGenerationTool(part) ||
        (part.tool === "code_mode" &&
          typeof part.state.input.code === "string" &&
          /\bgenerate_image\s*\(/.test(part.state.input.code)),
    ),
  )
  const belongs = (job: ImageJob) =>
    job.sessionID === props.sessionID &&
    ((job.inputID && props.inputIDs.includes(job.inputID)) ||
      imageTools().some((part) => part.callID === job.callID || imageToolJobID(part) === job.job_id))
  const receive = (jobs: ImageJob[]) => {
    const next = new Map(store.jobs.map((job) => [job.job_id, job]))
    for (const job of jobs)
      if (belongs(job) && (job.updated ?? 0) >= (next.get(job.job_id)?.updated ?? 0)) next.set(job.job_id, job)
    setStore(
      "jobs",
      reconcile(
        [...next.values()].filter(belongs).sort((a, b) => a.created - b.created),
        { key: "job_id" },
      ),
    )
  }
  createEffect(() => {
    props.sessionID
    props.inputIDs
    imageTools().forEach(imageToolJobID)
    if (imageTools().length || props.artifacts.length) {
      const detail = {
        sessionID: props.sessionID,
        receive: (jobs: ImageJob[]) => {
          receive(jobs)
          setStore("hydrated", true)
        },
      }
      // Mount the workspace event bridge before hydrating an existing chat.
      queueMicrotask(() => window.dispatchEvent(new CustomEvent("bitsbytes:image-query", { detail })))
    }
  })
  const update = (event: Event) => receive([(event as CustomEvent<ImageJob>).detail])
  window.addEventListener("bitsbytes:image-change", update)
  onCleanup(() => window.removeEventListener("bitsbytes:image-change", update))
  const rows = createMemo<ImageRow[]>(() => {
    const jobs = store.jobs.filter(belongs)
    const artifacts = new Set(jobs.flatMap((job) => (job.artifact ? [job.artifact.id] : [])))
    return [
      ...jobs.map((job, index) => ({
        key:
          job.callID && jobs.findIndex((previous) => previous.callID === job.callID) === index
            ? job.callID
            : job.job_id,
        status: job.status,
        artifact: job.artifact,
        error: job.error,
      })),
      ...imageTools()
        .filter(
          (part) =>
            !jobs.some(
              (job) => job.callID === part.callID || imageToolJobID(part) === job.job_id || part.tool === "code_mode",
            ),
        )
        .map((part) => ({
          key: part.callID,
          status:
            part.state.status === "error"
              ? ("error" as const)
              : ownsPart(data.store.session_status[props.sessionID], part)
                ? ("waiting" as const)
                : part.state.status === "completed"
                  ? store.hydrated
                    ? ("error" as const)
                    : ("loading" as const)
                  : ("canceled" as const),
          error: part.state.status === "error" ? part.state.error : undefined,
        })),
      ...props.artifacts
        .filter((artifact) => !artifacts.has(artifact.id) && !jobs.some((job) => job.job_id === artifact.image?.jobID))
        .map((artifact) => ({ key: artifact.id, status: "ready" as const, artifact })),
    ]
  })
  // Stable keys keep the same card mounted as a pending tool becomes a saved image.
  const keys = createMemo(() => rows().map((row) => row.key), undefined, {
    equals: (a, b) => !!a && a.length === b.length && a.every((key, index) => key === b[index]),
  })
  return (
    <Show when={keys().length}>
      <div class="bb-image-gallery" data-component="image-generation-gallery">
        <For each={keys()}>{(key) => <ImageGenerationCard row={rows().find((row) => row.key === key)!} />}</For>
      </div>
    </Show>
  )
}

function ImageGenerationCard(props: { row: ImageRow }) {
  const i18n = useI18n()
  const dialog = useDialog()
  const [view, setView] = createStore({ visible: false })
  const store = createImageContent(() => props.row.artifact, () => view.visible)
  let element: HTMLDivElement | undefined
  onMount(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setView("visible", true)
        observer.disconnect()
      },
      { rootMargin: "200px" },
    )
    observer.observe(element!)
    onCleanup(() => observer.disconnect())
  })
  const busy = () =>
    !store.failed &&
    (props.row.status === "preparing" ||
      props.row.status === "waiting" ||
      props.row.status === "loading" ||
      (props.row.status === "ready" && !store.loaded))
  const label = () => {
    const errors: Record<string, string> = {
      imageEditingUnsupported: "textOnly",
      imageReference: "referenceFailed",
      imageCredential: "credential",
      imageAccess: "access",
      imageQuota: "quota",
      imageRefused: "refused",
      imageUnavailable: "unavailable",
      imageOutput: "outputFailed",
    }
    const error = Object.entries(errors).find(([key]) => props.row.error?.includes(`bb.error.${key}`))?.[1]
    return i18n.t(
      store.failed
        ? "ui.imageGeneration.loadFailed"
        : error
          ? `ui.imageGeneration.${error}`
          : props.row.error?.includes("The user rejected permission")
            ? "ui.imageGeneration.notApproved"
            : props.row.status === "waiting"
              ? "ui.imageGeneration.waiting"
              : props.row.status === "preparing"
                ? "ui.imageGeneration.generating"
                : props.row.status === "canceled"
                  ? "ui.imageGeneration.canceled"
                  : props.row.status === "uncertain"
                    ? "ui.imageGeneration.uncertain"
                    : props.row.status === "error"
                      ? "ui.imageGeneration.failed"
                      : "ui.imageGeneration.loading",
    )
  }
  return (
    <div
      ref={element}
      class="bb-image-card"
      data-component="image-generation-card"
      data-status={props.row.status}
      data-loaded={store.loaded}
      aria-busy={busy()}
    >
      <Show when={store.src}>
        <button
          class="bb-image-preview"
          aria-label={i18n.t("ui.imageGeneration.enlarge")}
          onClick={() => dialog.show(() => <ImagePreview src={store.src} alt={props.row.artifact?.filename} />)}
        >
          <img
            src={store.src}
            alt={props.row.artifact?.filename ?? i18n.t("ui.imageGeneration.alt")}
          />
        </button>
      </Show>
      <Show when={!store.loaded}>
        <div class="bb-image-placeholder" data-animated={busy()} role="status" aria-live="polite">
          <Show when={busy()}>
            <div class="bb-image-dots" aria-hidden="true" />
          </Show>
          <span>{label()}</span>
        </div>
        <Show when={props.row.error}>
          <details class="bb-image-error">
            <summary>{i18n.t("ui.imageGeneration.details")}</summary>
            <pre>{props.row.error}</pre>
          </details>
        </Show>
      </Show>
      <Show when={store.loaded}>
        <Show when={store.failed}>
          <p class="bb-image-load-error" role="status">{i18n.t("ui.imageGeneration.loadFailed")}</p>
        </Show>
        <div class="bb-image-actions">
          <a
            href={store.src}
            download={props.row.artifact?.filename ?? "image.png"}
            aria-label={i18n.t("ui.imageGeneration.download")}
          >
            <Icon name="download" />
            <span>{i18n.t("ui.imageGeneration.download")}</span>
          </a>
          <button
            onClick={() => dialog.show(() => <ImagePreview src={store.src} alt={props.row.artifact?.filename} />)}
            aria-label={i18n.t("ui.imageGeneration.enlarge")}
          >
            <Icon name="expand" />
            <span>{i18n.t("ui.imageGeneration.enlarge")}</span>
          </button>
        </div>
      </Show>
    </div>
  )
}
