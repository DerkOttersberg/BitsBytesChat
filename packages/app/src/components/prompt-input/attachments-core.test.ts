import { expect, test } from "bun:test"
import type { ContentPart } from "@/context/prompt"
import { createPromptAttachmentsCore } from "./attachments"
import { MAX_ATTACHMENT_BYTES } from "./files"

function setup() {
  let parts: ContentPart[] = []
  const warnings: ("size" | undefined)[] = []
  const blobs: Blob[] = []
  const core = createPromptAttachmentsCore({
    allowBinary: true,
    editor: () => document.createElement("div"),
    capture: () => ({
      current: () => parts,
      cursor: () => 0,
      set: (next) => {
        parts = next
      },
    }),
    warn: (reason) => warnings.push(reason),
    draftStore: {
      getItem: async () => null,
      setItem: async () => undefined,
      removeItem: async () => undefined,
      putBlob: async (blob) => {
        blobs.push(blob)
        return { id: "fixture-" + blobs.length, url: "blob:fixture-" + blobs.length }
      },
    },
  })
  return { core, parts: () => parts, warnings, blobs }
}

function sized(name: string, size: number) {
  const file = new File([Uint8Array.of(0, 255, 1, 2)], name, { type: "application/octet-stream" })
  Object.defineProperty(file, "size", { value: size })
  return file
}

test("desktop saves opaque source blobs and preserves names, MIME and measured size", async () => {
  const ctx = setup()
  const file = sized("save.nbt", 4)
  expect(await ctx.core.addAttachment(file)).toBe(true)
  expect(ctx.parts()).toMatchObject([
    { type: "image", filename: "save.nbt", mime: "application/octet-stream", size: 4, blob: { id: "fixture-1" } },
  ])
  expect(ctx.blobs).toEqual([file])
  expect(ctx.warnings).toEqual([])
})

test("oversized batches leave the draft intact and show one size explanation", async () => {
  const ctx = setup()
  await ctx.core.addAttachment(sized("retained.bin", 10))
  expect(await ctx.core.addAttachments([sized("large.bin", MAX_ATTACHMENT_BYTES - 10), sized("extra.bin", 1)])).toBe(
    false,
  )
  expect(ctx.parts()).toHaveLength(1)
  expect(ctx.blobs).toHaveLength(1)
  expect(ctx.warnings).toEqual(["size"])
  expect(await ctx.core.addAttachment(sized("exact.bin", MAX_ATTACHMENT_BYTES - 10))).toBe(true)
})

test.each(["file", "batch"] as const)("concurrent %s pickers cannot exceed the per-message budget", async (mode) => {
  const ctx = setup()
  const add = (file: File) => (mode === "file" ? ctx.core.addAttachment(file) : ctx.core.addAttachments([file]))
  const results = await Promise.all([add(sized("first.bin", MAX_ATTACHMENT_BYTES)), add(sized("second.bin", 1))])
  expect(results).toEqual([true, false])
  expect(ctx.parts()).toHaveLength(1)
  expect(ctx.warnings).toEqual(["size"])
})
