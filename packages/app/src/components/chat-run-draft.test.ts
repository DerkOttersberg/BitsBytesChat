import { expect, test } from "bun:test"
import { readQueuedDraft, restoreQueuedDraft } from "./chat-run-draft"

const text = { type: "text" as const, content: "Complete source 🌿", start: 0, end: 18 }
const draft = {
  sessionID: "ses_saved",
  sessionDirectory: "C:/workspace",
  prompt: [text],
  context: [],
  agent: "build",
  model: { providerID: "fixture", modelID: "fixture" },
}

test.each(
  [
    undefined,
    null,
    [],
    { transcript: "bitsbytes://transcript/source?revision=7" },
    { ...draft, prompt: {} },
    { ...draft, prompt: [null] },
    { ...draft, prompt: [{ ...text, content: {} }] },
    { ...draft, prompt: [{ ...text, type: "unknown" }] },
    { ...draft, context: {} },
    { ...draft, context: [null] },
    { ...draft, context: [{ type: "file", path: "C:/source" }] },
    { ...draft, context: [{ type: "file", path: "C:/source", key: "saved", comment: {} }] },
    {
      ...draft,
      context: [
        { type: "file", path: "C:/source", key: "saved", attachment: { kind: "transcript", id: "saved", name: {} } },
      ],
    },
    { ...draft, model: null },
    { ...draft, variant: {} },
  ].map((value) => ({ value })),
)("damaged queued editing metadata cannot reach composer operations (%#)", ({ value }) => {
  expect(readQueuedDraft(value)).toBeUndefined()
})

test("valid source, context and model remain intact", () => {
  const value = {
    ...draft,
    variant: "high",
    context: [
      {
        type: "file" as const,
        path: "bitsbytes://transcript/source?revision=7",
        key: "saved",
        attachment: { kind: "transcript" as const, id: "source", name: "Saved source", revision: 7 },
      },
    ],
  }
  expect(readQueuedDraft(value)).toBe(value)
  expect(restoreQueuedDraft(readQueuedDraft(value)!)).toEqual(value)
})

test("portable images with identical filenames retain separate sources and usable IDs", () => {
  const first = "data:image/png;base64,Zmlyc3Q=",
    second = "data:image/png;base64,c2Vjb25k"
  const value = {
    ...draft,
    prompt: [
      text,
      { type: "image", filename: "image.png", mime: "image/png", dataUrl: first },
      { type: "image", filename: "image.png", mime: "image/png", dataUrl: second },
    ],
  }
  const source = JSON.stringify(value)
  const restored = restoreQueuedDraft(readQueuedDraft(value)!)
  const images = restored.prompt.filter((part) => part.type === "image")
  expect(images.map((image) => image.blob.url)).toEqual([first, second])
  expect(new Set(images.map((image) => image.id)).size).toBe(2)
  expect(images.every((image) => typeof image.id === "string" && image.id.length > 0)).toBe(true)
  expect(JSON.stringify(value)).toBe(source)
})

test("current image IDs and blob references are retained; duplicate saved IDs are repaired", () => {
  const image = {
    type: "image",
    id: "saved-image",
    filename: "image.png",
    mime: "image/png",
    blob: { id: "blob-id", url: "blob:fixture" },
  }
  const restored = restoreQueuedDraft(readQueuedDraft({ ...draft, prompt: [image, image] })!)
  const images = restored.prompt.filter((part) => part.type === "image")
  expect(images[0].id).toBe(image.id)
  expect(images[1].id).not.toBe(image.id)
  expect(images.map((image) => image.blob)).toEqual([image.blob, image.blob])
})

test.each([
  { type: "image", filename: "image.png", mime: "image/png" },
  { type: "image", filename: "image.png", mime: "image/png", dataUrl: "https://fixture/image.png" },
  { type: "image", filename: "image.png", mime: "image/png", blob: { id: "source" } },
  { type: "image", filename: "image.png", mime: "image/png", dataUrl: {}, blob: { id: "source", url: "blob:fixture" } },
])("incomplete saved images disable optional editing without altering engine source (%#)", (image) => {
  expect(readQueuedDraft({ ...draft, prompt: [image] })).toBeUndefined()
})
