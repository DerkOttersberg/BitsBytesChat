import { expect, test } from "bun:test"
import { brandTemplate, resolveBrandedTemplate } from "./language-brand"

test("custom tool permission descriptions missing from the dictionary cannot crash branding", () => {
  const key = "settings.permissions.tool.bitsbytes-local_open_artifact.description"
  expect(resolveBrandedTemplate(key, undefined, undefined, "Bits & Bytes Chat")).toBe(key)
  expect(resolveBrandedTemplate(key, undefined)).toBe(key)
})

test("branding changes source copy while preserving interpolated filenames and errors", () => {
  const params = {
    filename: "OpenCode Desktop notes.txt",
    error: "OpenCode could not read C:\\OpenCode\\data.json",
  }
  expect(
    resolveBrandedTemplate(
      "fixture.description",
      "OpenCode Desktop: {{filename}} — {{error}}",
      params,
      "Bits & Bytes Chat",
    ),
  ).toBe("Bits & Bytes Chat: OpenCode Desktop notes.txt — OpenCode could not read C:\\OpenCode\\data.json")
  expect(params.filename).toBe("OpenCode Desktop notes.txt")
  expect(params.error).toBe("OpenCode could not read C:\\OpenCode\\data.json")
})

test.each(["provider.connect.opencodeZen.description", "dialog.model.unpaid.freeModels.title"])(
  "provider source copy retains its product name (%s)",
  (key) => {
    expect(
      resolveBrandedTemplate(key, "OpenCode Zen {{filename}}", { filename: "OpenCode.md" }, "Bits & Bytes Chat"),
    ).toBe("OpenCode Zen OpenCode.md")
  },
)

test("upstream copy and interpolation are unchanged when desktop branding is absent", () => {
  expect(resolveBrandedTemplate("fixture", "OpenCode {{count}} {{value}}", { count: 2, value: false })).toBe(
    "OpenCode 2 false",
  )
})

test("native template branding keeps placeholders and the application name literal", () => {
  expect(brandTemplate("fixture", "OpenCode Desktop {{filename}}", "Bits $& Bytes")).toBe("Bits $& Bytes {{filename}}")
})
