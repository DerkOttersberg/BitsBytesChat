import { expect, test } from "bun:test"
import { recordedSources } from "./message-source"

test("provider citations preserve recorded order, latest source identity and document names", () => {
  const metadata = {
    sources: [
      { id: "web", sourceType: "url", url: "https://example.com/read", title: "Earlier title" },
      { id: "document", sourceType: "document", filename: "Saved report.pdf" },
      { id: "web", sourceType: "url", url: "https://example.com/read", title: "Final title" },
    ],
  }
  const before = JSON.stringify(metadata)
  expect(recordedSources(metadata)).toMatchObject([
    { id: "web", url: "https://example.com/read", title: "Final title" },
    { id: "document", filename: "Saved report.pdf" },
  ])
  expect(JSON.stringify(metadata)).toBe(before)
})

test.each([
  "javascript:alert(1)",
  "file:///C:/private.txt",
  "data:text/html,unsafe",
  "https://user:secret@example.com",
  "invalid URL",
])("unsafe recorded source cannot navigate: %s", (url) => {
  expect(recordedSources({ sources: [{ id: "record", sourceType: "url", url, title: "Provider record" }] })).toEqual([
    { id: "record", sourceType: "url", title: "Provider record", filename: undefined },
  ])
})

test("damaged optional sources leave the answer usable and never create inferred references", () => {
  expect(recordedSources(undefined)).toEqual([])
  expect(recordedSources({ sources: "https://example.com" })).toEqual([])
  expect(
    recordedSources({
      sources: [null, 1, {}, { id: "", sourceType: "url" }, { id: "source", sourceType: "invented" }],
    }),
  ).toEqual([])
})
