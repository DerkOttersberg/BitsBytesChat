import { expect, test } from "bun:test"
import { readToolImages } from "./read-tool-images"

const image = { type: "file", mime: "image/png", filename: "recorded.png", url: "data:image/png;base64,c25hcHNob3Q=" }

test("completed raster reads retain recorded references and exact bytes without filename inference", () => {
  const jpeg = { ...image, mime: "image/jpeg", filename: "no-extension", url: "data:image/jpeg;base64,anBlZw==" }
  const state = { status: "completed", attachments: [image, jpeg] }
  const source = JSON.stringify(state)
  expect(readToolImages(state)).toEqual([
    { mime: image.mime, filename: image.filename, url: image.url, attachmentIndex: 0 },
    { mime: jpeg.mime, filename: jpeg.filename, url: jpeg.url, attachmentIndex: 1 },
  ])
  expect(JSON.stringify(state)).toBe(source)
})

test.each(["pending", "running", "error", undefined])(
  "incomplete or failed reads cannot claim a viewed image (%s)",
  (status) => {
    expect(readToolImages({ status, attachments: [image] })).toEqual([])
  },
)

test("a misleading PNG filename, remote URL or mismatched data MIME cannot produce a thumbnail", () => {
  const attachments = [
    { ...image, mime: "text/plain", url: "data:text/plain;base64,dGV4dA==" },
    { ...image, url: "https://fixture.invalid/changed.png" },
    { ...image, url: "file:///C:/changed.png" },
    { ...image, url: "data:image/jpeg;base64,anBlZw==" },
    { ...image, mime: "image/svg+xml", url: "data:image/svg+xml;base64,c3Zn" },
    { ...image, url: "data:image/png;base64," },
    { ...image, type: "text" },
    { ...image, filename: {} },
    null,
    { mime: "image/png", url: null },
    image,
  ]
  expect(readToolImages({ status: "completed", attachments })).toEqual([
    { mime: image.mime, filename: image.filename, url: image.url, attachmentIndex: 10 },
  ])
})

test.each([undefined, null, {}, "damaged", 3].map((attachments) => ({ attachments })))(
  "damaged optional attachments leave the ordinary read usable (%#)",
  ({ attachments }) => {
    expect(readToolImages({ status: "completed", attachments })).toEqual([])
  },
)
