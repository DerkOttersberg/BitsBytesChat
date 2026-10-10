import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createPromptInputV2Attachments, MAX_ATTACHMENT_BYTES, type PromptInputV2AttachmentConfig } from "./attachments"
import type { PromptInputV2Prompt } from "./types"

function setup(allowBinary = true, picker?: PromptInputV2AttachmentConfig["picker"]) {
  return createRoot((dispose) => {
    let parts: PromptInputV2Prompt = []
    const warnings: ("size" | undefined)[] = []
    const blobs: File[] = []
    let duplicates = 0
    const core = createPromptInputV2Attachments({
      allowBinary,
      picker,
      directory: () => "fixture",
      isDialogActive: () => false,
      warn: (reason) => warnings.push(reason),
      duplicate: () => duplicates++,
      onError: (error) => {
        throw error
      },
      editor: () => document.createElement("div"),
      capture: () => ({
        current: () => parts,
        cursor: () => 0,
        set: (next) => {
          parts = next
        },
      }),
      focusEditor: () => undefined,
      addPart: () => false,
      setDraggingType: () => undefined,
      store: async (file) => {
        blobs.push(file)
        return { id: "fixture-content", url: "blob:fixture" }
      },
    })
    return { core, parts: () => parts, warnings, blobs, duplicates: () => duplicates, dispose }
  })
}

function sized(name: string, size: number, type = "application/octet-stream") {
  const file = new File([Uint8Array.of(0, 255, 1, 2)], name, { type })
  Object.defineProperty(file, "size", { value: size })
  return file
}

test("v2 desktop preserves opaque source bytes, MIME, filename and measured size", async () => {
  const ctx = setup()
  try {
    const file = sized("save.nbt", 4)
    expect(await ctx.core.addAttachments([file])).toBe(true)
    expect(ctx.parts()).toMatchObject([
      { type: "image", filename: "save.nbt", mime: "application/octet-stream", size: 4 },
    ])
    expect(ctx.blobs).toEqual([file])
    expect(ctx.warnings).toEqual([])
  } finally {
    ctx.dispose()
  }
})

test("v2 unknown binary MIME gets a usable octet-stream fallback", async () => {
  const ctx = setup()
  try {
    expect(await ctx.core.addAttachments([sized("unknown", 4, "")])).toBe(true)
    expect(ctx.parts()).toMatchObject([{ mime: "application/octet-stream" }])
  } finally {
    ctx.dispose()
  }
})

test("v2 non-desktop defaults retain opaque-file rejection", async () => {
  const ctx = setup(false)
  try {
    expect(await ctx.core.addAttachments([sized("save.nbt", 4)])).toBe(false)
    expect(ctx.parts()).toEqual([])
    expect(ctx.blobs).toEqual([])
    expect(ctx.warnings).toEqual([undefined])
  } finally {
    ctx.dispose()
  }
})

test("v2 oversized batches do not partially change the draft or save source blobs", async () => {
  const ctx = setup()
  try {
    await ctx.core.addAttachments([sized("retained.bin", 10)])
    expect(await ctx.core.addAttachments([sized("large.bin", MAX_ATTACHMENT_BYTES - 10), sized("extra.bin", 1)])).toBe(
      false,
    )
    expect(ctx.parts()).toHaveLength(1)
    expect(ctx.blobs).toHaveLength(1)
    expect(ctx.warnings).toEqual(["size"])
  } finally {
    ctx.dispose()
  }
})

test("v2 accepts the exact message budget and explains a later excess", async () => {
  const ctx = setup()
  try {
    expect(await ctx.core.addAttachments([sized("exact.bin", MAX_ATTACHMENT_BYTES)])).toBe(true)
    expect(await ctx.core.addAttachments([sized("extra.bin", 1)])).toBe(false)
    expect(ctx.parts()).toHaveLength(1)
    expect(ctx.warnings).toEqual(["size"])
  } finally {
    ctx.dispose()
  }
})

test("v2 concurrent picker completions cannot overrun the message budget", async () => {
  const ctx = setup()
  try {
    const added = await Promise.all([
      ctx.core.addAttachments([sized("first.bin", MAX_ATTACHMENT_BYTES)]),
      ctx.core.addAttachments([sized("second.bin", 1)]),
    ])
    expect(added).toEqual([true, false])
    expect(ctx.parts()).toHaveLength(1)
    expect(ctx.warnings).toEqual(["size"])
  } finally {
    ctx.dispose()
  }
})

test("v2 native picker removes extension filters only for binary-capable hosts", () => {
  const options: { accept?: string[] }[] = []
  const picker: PromptInputV2AttachmentConfig["picker"] = async (value) => {
    options.push(value)
  }
  const desktop = setup(true, picker),
    web = setup(false, picker)
  try {
    desktop.core.pick(() => {
      throw Error("Unexpected fallback")
    })
    web.core.pick(() => {
      throw Error("Unexpected fallback")
    })
    expect(options[0].accept).toBeUndefined()
    expect(options[1].accept).toContain("application/pdf")
  } finally {
    desktop.dispose()
    web.dispose()
  }
})

test("v2 retains byte-reference duplicate detection", async () => {
  const ctx = setup()
  try {
    await ctx.core.addAttachments([sized("same.bin", 4)])
    expect(await ctx.core.addAttachments([sized("same.bin", 4)])).toBe(true)
    expect(ctx.parts()).toHaveLength(1)
    expect(ctx.duplicates()).toBe(1)
    expect(ctx.warnings).toEqual([])
  } finally {
    ctx.dispose()
  }
})
