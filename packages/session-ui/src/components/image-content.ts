import { createEffect, createMemo, on, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"

type ImageContent = { id: string; sessionID: string; revision: number }
type ImageBytes = { data: Uint8Array; mime: string }

export function createImageContent(artifact: Accessor<ImageContent | undefined>, visible: Accessor<boolean>) {
  const [store, setStore] = createStore({ src: "", loaded: false, failed: false })
  // Job/catalog hydration replaces metadata objects without changing bytes.
  const content = createMemo(
    () => {
      const item = artifact()
      return item && { id: item.id, sessionID: item.sessionID, revision: item.revision }
    },
    undefined,
    {
      equals: (a, b) => a?.id === b?.id && a?.sessionID === b?.sessionID && a?.revision === b?.revision,
    },
  )
  let generation = 0
  let current = ""
  createEffect(
    on(
      () => (visible() ? content() : undefined),
      (item) => {
        if (!item) return
        const token = ++generation
        let candidate = ""
        let received = false
        setStore("failed", false)
        window.dispatchEvent(
          new CustomEvent("bitsbytes:image-content", {
            detail: {
              ...item,
              receive: (result: ImageBytes | undefined) => {
                if (token !== generation || received) return
                received = true
                if (!result?.mime.startsWith("image/")) return setStore("failed", true)
                candidate = URL.createObjectURL(new Blob([new Uint8Array(result.data)], { type: result.mime }))
                const image = new Image()
                image.src = candidate
                // Keep a displayed PNG until its replacement has decoded successfully.
                void image
                  .decode()
                  .then(() => {
                    if (token !== generation) return
                    const previous = current
                    current = candidate
                    setStore({ src: current, loaded: true, failed: false })
                    if (previous) URL.revokeObjectURL(previous)
                  })
                  .catch(() => {
                    if (token !== generation) return
                    URL.revokeObjectURL(candidate)
                    candidate = ""
                    setStore("failed", true)
                  })
              },
            },
          }),
        )
        onCleanup(() => {
          generation++
          if (candidate && candidate !== current) URL.revokeObjectURL(candidate)
        })
      },
    ),
  )
  onCleanup(() => {
    generation++
    if (current) URL.revokeObjectURL(current)
  })
  return store
}
