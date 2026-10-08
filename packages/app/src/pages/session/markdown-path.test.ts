import { expect, test } from "bun:test"
import { markdownFileIdentity, markdownLinkPath } from "./markdown-path"

test("Working Markdown view identities distinguish the same relative file in different projects", () => {
  const tab = "file://README.md"
  expect(markdownFileIdentity("D:\\Project one", tab)).not.toBe(markdownFileIdentity("D:\\Project two", tab))
  expect(markdownFileIdentity("D:\\Project one", tab)).toBe(markdownFileIdentity("D:\\Project one", tab))
  expect(markdownFileIdentity("D:\\Project one", tab)).not.toBe(markdownFileIdentity("D:\\Project one", "file://docs/README.md"))
})

test("Markdown document links use the active workspace and preserve Windows filenames", () => {
  expect(markdownLinkPath("docs/Plan #1.md", "D:\\Project space", "images/diagram%20one.png#view")).toBe("D:/Project space/docs/images/diagram one.png")
  expect(markdownLinkPath("D:\\Project space\\docs\\Plan #1.md", undefined, "../notes/%23details.md")).toBe("D:/Project space/notes/#details.md")
  expect(markdownLinkPath("D:\\Project\\plan.md", undefined, "C:\\Other\\notes.md")).toBe("C:/Other/notes.md")
  expect(markdownLinkPath("/workspace/docs/plan.md", undefined, "../résumé.md")).toBe("/workspace/résumé.md")
})

test("Markdown document links preserve UNC hosts and reject non-file schemes or malformed encoding", () => {
  expect(markdownLinkPath("\\\\server\\share\\docs\\plan.md", undefined, "../diagram.png")).toBe("//server/share/diagram.png")
  expect(markdownLinkPath("docs/plan.md", "\\\\server\\share", "file:///D:/Project/notes.md")).toBe("D:/Project/notes.md")
  for (const href of ["javascript:alert(1)", "data:text/html,test", "https://example.invalid/image.png", "%ZZ.png"])
    expect(markdownLinkPath("D:/Project/plan.md", undefined, href)).toBeUndefined()
  expect(markdownLinkPath("docs/plan.md", undefined, "image.png")).toBeUndefined()
})
