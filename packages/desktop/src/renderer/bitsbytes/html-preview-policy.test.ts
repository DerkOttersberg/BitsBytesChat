import { expect, test } from "bun:test"
import { htmlPreviewSandbox, isolatedHTML } from "./html-preview-policy"

test("interactive form handlers are allowed while origin, navigation and network restrictions remain", () => {
  expect(htmlPreviewSandbox.split(" ")).toEqual(["allow-scripts", "allow-forms"])
  expect(htmlPreviewSandbox).not.toContain("allow-same-origin")
  expect(htmlPreviewSandbox).not.toContain("allow-top-navigation")
  const text =
    '<!doctype html><form id="example"><button>Add</button></form><script>example.onsubmit=e=>e.preventDefault()</script>'
  const html = isolatedHTML(text)
  expect(html.endsWith(text)).toBe(true)
  expect(html).toContain("form-action 'none'")
  expect(html).toContain("connect-src 'none'")
  expect(html).toContain("base-uri 'none'")
})
