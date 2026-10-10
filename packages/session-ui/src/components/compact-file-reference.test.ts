import { expect, test } from "bun:test"
import { compactFileReference } from "./compact-file-reference"

test("absolute file references retain their full path and show only the filename", () => {
  expect(compactFileReference("D:\\Workspace\\mod\\build\\libs\\mod.jar")).toEqual({
    filename: "mod.jar",
    path: "D:\\Workspace\\mod\\build\\libs\\mod.jar",
  })
  expect(compactFileReference("C:/My project/README.md:12")?.filename).toBe("README.md:12")
  expect(compactFileReference("/C:/Downloads/My Document.docx")?.filename).toBe("My Document.docx")
})

test("directories, relative references, URLs and commands keep their original presentation", () => {
  for (const text of [
    "C:\\Program Files\\Java\\jdk-25",
    "src/mod.java",
    "https://example.com/file.zip",
    "C:\\Tools\\java.exe -jar mod.jar",
    "C:\\Tools\\python.exe script.py",
    "C:\\file.txt | copy C:\\other.txt",
    "C:\\file\n.txt",
    "C:\\file.txt && echo done.txt",
  ])
    expect(compactFileReference(text)).toBeUndefined()
})
