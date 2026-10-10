import assert from "node:assert/strict"

// Exercise the real desktop event bridge with unchanged saved-image contents.
// No model request is made and the fixture session alone receives these events.
export async function verifyImageStability(page, sessionID, baseline = false) {
  const result = await page.evaluate(async (sessionID) => {
    const main = document.querySelector(`.bb-workspace-chat[data-bb-chat="${sessionID}"]`)
    const card = [...main.querySelectorAll('[data-component="image-generation-card"][data-loaded="true"]')].findLast(
      (element) => element.getBoundingClientRect().width > 0,
    )
    const image = card.querySelector("img")
    const src = image.src
    const jobs = await window.api.bitsbytes.call("images.list", { sessionID })
    const artifacts = await window.api.bitsbytes.call("artifacts.list")
    const ready = jobs.find((job) => job.status === "ready")
    let contentRequests = 0
    let srcChanges = 0
    let placeholderResets = 0
    let imageLoads = 0
    const request = () => contentRequests++
    const load = () => imageLoads++
    window.addEventListener("bitsbytes:image-content", request)
    image.addEventListener("load", load)
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.attributeName === "src") srcChanges++
        if (record.attributeName === "data-loaded" && record.oldValue === "true") placeholderResets++
      }
    })
    observer.observe(card, { subtree: true, attributes: true, attributeOldValue: true })
    for (let index = 0; index < 8; index++) {
      // Equal content with fresh objects reproduces provider/status hydration,
      // followed by an unrelated artifact catalog broadcast.
      window.dispatchEvent(
        new CustomEvent("bitsbytes:image-change", {
          detail: { ...structuredClone(ready), updated: (ready.updated ?? 0) + index + 1 },
        }),
      )
      window.dispatchEvent(new CustomEvent("bitsbytes:artifact-change", { detail: structuredClone(artifacts) }))
      await new Promise((resolve) => setTimeout(resolve, 90))
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
    observer.disconnect()
    window.removeEventListener("bitsbytes:image-content", request)
    image.removeEventListener("load", load)
    return {
      broadcasts: 16,
      contentRequests,
      srcChanges,
      placeholderResets,
      imageLoads,
      sameCard: card.isConnected,
      sameImage: image.isConnected,
      sameSrc: card.querySelector("img")?.src === src,
      loaded: card.dataset.loaded,
      cursor: {
        chat: getComputedStyle(main).cursor,
        text: getComputedStyle(main.querySelector('[data-component="user-message"]') ?? main).cursor,
        editor: getComputedStyle(main.querySelector('[contenteditable="true"]')).cursor,
        image: getComputedStyle(image.parentElement).cursor,
      },
    }
  }, sessionID)
  assert.equal(result.sameCard, true, "metadata updates preserve the image card")
  assert.equal(result.loaded, "true")
  if (!baseline) {
    assert.equal(result.contentRequests, 0, "unchanged image contents are never reloaded")
    assert.equal(result.srcChanges, 0, "metadata updates never replace the PNG URL")
    assert.equal(result.placeholderResets, 0, "a loaded PNG never returns to its placeholder")
    assert.equal(result.sameImage, true)
    assert.equal(result.sameSrc, true)
    assert.equal(result.cursor.chat, "default")
    assert.equal(result.cursor.editor, "text")
    assert.equal(result.cursor.image, "zoom-in")
  }
  return result
}

export async function verifyImageReplacement(page, sessionID, red, blue) {
  const result = await page.evaluate(
    async ({ sessionID, red, blue }) => {
      const main = document.querySelector(`.bb-workspace-chat[data-bb-chat="${sessionID}"]`)
      const card = [...main.querySelectorAll('[data-component="image-generation-card"][data-loaded="true"]')].findLast(
        (element) => element.getBoundingClientRect().width > 0,
      )
      const image = card.querySelector("img")
      const originalSrc = image.src
      const jobs = await window.api.bitsbytes.call("images.list", { sessionID })
      const job = jobs.find((job) => job.status === "ready")
      const requests = new Map()
      const replies = []
      const decodes = []
      const releases = []
      const revoke = URL.revokeObjectURL
      const decode = HTMLImageElement.prototype.decode
      URL.revokeObjectURL = function (url) {
        releases.push(url)
        return revoke.call(this, url)
      }
      HTMLImageElement.prototype.decode = function () {
        const src = this.src
        return decode.call(this).then(
          () => {
            decodes.push({ src, success: true })
          },
          (error) => {
            decodes.push({ src, success: false, message: error.message })
            throw error
          },
        )
      }
      const intercept = (event) => {
        if (event.detail.id !== job.artifact.id) return
        event.stopImmediatePropagation()
        event.detail.handled = true
        const receive = event.detail.receive
        // Window-targeted events may already have reached the real bridge.
        // Its asynchronous reply must not race this fixture's fake revisions.
        event.detail.receive = () => undefined
        const receivers = requests.get(event.detail.revision) ?? []
        receivers.push((value) => {
          replies.push({ revision: event.detail.revision, mime: value?.mime, length: value?.data?.length })
          receive(value)
        })
        requests.set(event.detail.revision, receivers)
      }
      let resets = 0
      const observer = new MutationObserver((records) => {
        resets += records.filter(
          (record) => record.attributeName === "data-loaded" && record.oldValue === "true",
        ).length
      })
      observer.observe(card, { attributes: true, attributeOldValue: true })
      window.addEventListener("bitsbytes:image-content", intercept, true)
      const update = (revision) =>
        window.dispatchEvent(
          new CustomEvent("bitsbytes:image-change", {
            detail: {
              ...structuredClone(job),
              updated: (job.updated ?? 0) + 100 + revision,
              artifact: { ...job.artifact, revision },
            },
          }),
        )
      const wait = async (read, label) => {
        for (let index = 0; index < 250; index++) {
          if (read()) return
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        throw Error(
          `Image replacement did not settle: ${label}; requested revisions ${[...requests.keys()]}; ` +
            JSON.stringify({
              cardConnected: card.isConnected,
              imageConnected: image.isConnected,
              src: image.src,
              currentSrc: card.querySelector("img")?.src,
              loaded: card.dataset.loaded,
              complete: image.complete,
              naturalWidth: image.naturalWidth,
              error: card.querySelector(".bb-image-load-error")?.textContent,
              replies,
              decodes,
              releases,
              cards: [...main.querySelectorAll('[data-component="image-generation-card"]')].map((element) => ({
                loaded: element.dataset.loaded,
                width: element.getBoundingClientRect().width,
              })),
              requestCounts: [...requests].map(([revision, receivers]) => [revision, receivers.length]),
            }),
        )
      }
      const reply = (revision, bytes) =>
        requests
          .get(revision)
          .forEach((receive) => receive(bytes && { data: new Uint8Array(bytes), mime: "image/png" }))
      const pixel = () => {
        const canvas = document.createElement("canvas")
        canvas.width = canvas.height = 1
        canvas.getContext("2d").drawImage(image, image.naturalWidth / 2, image.naturalHeight / 2, 1, 1, 0, 0, 1, 1)
        return [...canvas.getContext("2d").getImageData(0, 0, 1, 1).data]
      }
      try {
        update(2)
        await wait(() => requests.has(2), "revision 2 requested")
        const held = image.src === originalSrc && card.dataset.loaded === "true"
        reply(2, red)
        reply(2, blue)
        await wait(() => image.src !== originalSrc && image.complete && image.naturalWidth > 0, "red PNG decoded")
        const redPixel = pixel()
        const redSrc = image.src
        const revokedOriginal = await fetch(originalSrc).then(
          () => false,
          () => true,
        )
        update(3)
        await wait(() => requests.has(3), "revision 3 requested")
        reply(3, undefined)
        await wait(() => !!card.querySelector(".bb-image-load-error"), "failed request reported")
        const retainedAfterFailure = image.src === redSrc && card.dataset.loaded === "true"
        update(4)
        await wait(() => requests.has(4), "held revision 4 requested")
        update(5)
        await wait(() => requests.has(5), "newer revision 5 requested")
        reply(4, blue)
        await new Promise((resolve) => setTimeout(resolve, 80))
        const staleIgnored = image.src === redSrc
        reply(5, blue)
        await wait(() => image.src !== redSrc && image.complete && image.naturalWidth > 0, "blue PNG decoded")
        const bluePixel = pixel()
        const blueSrc = image.src
        update(6)
        await wait(() => requests.has(6), "revision 6 requested")
        reply(6, [0, 1, 2, 3])
        await wait(() => !!card.querySelector(".bb-image-load-error"), "decode failure reported")
        const retainedAfterDecodeFailure = image.src === blueSrc && card.dataset.loaded === "true"
        return {
          held,
          redPixel,
          bluePixel,
          revokedOriginal,
          retainedAfterFailure,
          staleIgnored,
          retainedAfterDecodeFailure,
          resets,
          sameImage: image.isConnected,
        }
      } finally {
        URL.revokeObjectURL = revoke
        HTMLImageElement.prototype.decode = decode
        observer.disconnect()
        window.removeEventListener("bitsbytes:image-content", intercept, true)
        window.dispatchEvent(
          new CustomEvent("bitsbytes:image-change", {
            detail: { ...job, updated: (job.updated ?? 0) + 1000 },
          }),
        )
      }
    },
    { sessionID, red: [...red], blue: [...blue] },
  )
  assert.equal(result.held, true)
  assert.deepEqual(result.redPixel, [255, 0, 0, 255])
  assert.deepEqual(result.bluePixel, [0, 0, 255, 255])
  assert.equal(result.revokedOriginal, true)
  assert.equal(result.retainedAfterFailure, true)
  assert.equal(result.staleIgnored, true)
  assert.equal(result.retainedAfterDecodeFailure, true)
  assert.equal(result.resets, 0)
  assert.equal(result.sameImage, true)
  return result
}
