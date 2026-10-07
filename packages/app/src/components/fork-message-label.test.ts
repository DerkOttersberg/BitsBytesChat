import { expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { forkMessageLabel } from "./fork-message-label"

const file = {
  id: "file_1",
  sessionID: "session_1",
  messageID: "message_1",
  type: "file",
  mime: "image/png",
  filename: "OpenCode image.png",
  url: "data:image/png;base64,c25hcHNob3Q=",
} satisfies Part
const text = {
  id: "text_1",
  sessionID: "session_1",
  messageID: "message_1",
  type: "text",
  text: "Original\nrequest",
} satisfies Part

test("attachment-only fork rows use the filename without changing recorded parts", () => {
  const parts = [file]
  const before = JSON.stringify(parts)
  expect(forkMessageLabel(parts, "Bijlage")).toBe("OpenCode image.png")
  expect(JSON.stringify(parts)).toBe(before)
})

test.each([undefined, "", "   "])("unnamed attachment rows use the localized label (%#)", (filename) => {
  expect(forkMessageLabel([{ ...file, filename }], "Bijlage")).toBe("Bijlage")
})

test("ordinary text keeps its previous preview and takes priority over attachment names", () => {
  expect(forkMessageLabel([file, text], "Bijlage")).toBe("Original request")
  expect(forkMessageLabel([{ ...text, text: "x".repeat(210) }, file], "Bijlage")).toBe("x".repeat(200))
})

test("synthetic, ignored or empty text does not hide an attachment-only fork", () => {
  expect(forkMessageLabel([{ ...text, synthetic: true }, file], "Bijlage")).toBe(file.filename)
  expect(forkMessageLabel([{ ...text, ignored: true }, file], "Bijlage")).toBe(file.filename)
  expect(forkMessageLabel([{ ...text, text: " \n" }, file], "Bijlage")).toBe(file.filename)
})

test("messages without user text or attachments remain omitted", () => {
  expect(forkMessageLabel([], "Bijlage")).toBeUndefined()
  expect(forkMessageLabel([{ ...text, synthetic: true }], "Bijlage")).toBeUndefined()
  expect(forkMessageLabel([{ ...text, ignored: true }], "Bijlage")).toBeUndefined()
})
