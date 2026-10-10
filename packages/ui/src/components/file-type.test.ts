import { expect, test } from "bun:test"
import { fileType } from "./file-type"

test("Office filenames have distinct document, spreadsheet and presentation icons", () => {
  expect(fileType("notes.docx")).toBe("word")
  expect(fileType("budget.xlsx")).toBe("spreadsheet")
  expect(fileType("slides.pptx")).toBe("presentation")
})

test("PDF, code, images and general files have distinct types", () => {
  expect(fileType("notes.pdf", "document")).toBe("pdf")
  expect(fileType("app.tsx")).toBe("code")
  expect(fileType("photo.png")).toBe("image")
  expect(fileType("archive.zip")).toBe("file")
})

test("Windows paths and uppercase extensions retain their type", () => {
  expect(fileType("C:\\work\\QA.NOTES.DOCX")).toBe("word")
  expect(fileType("C:\\work\\BUDGET.XLSM")).toBe("spreadsheet")
  expect(fileType("/work/IMAGE.WEBP")).toBe("image")
})

test("extensionless artifacts use their declared kind", () => {
  expect(fileType("Notes", "document")).toBe("word")
  expect(fileType("Budget", "spreadsheet")).toBe("spreadsheet")
  expect(fileType("Slides", "presentation")).toBe("presentation")
  expect(fileType("Source", "source")).toBe("code")
  expect(fileType("Other", "file")).toBe("file")
})
