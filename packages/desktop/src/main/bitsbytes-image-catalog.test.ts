import { expect, test } from "bun:test"
import { imageCatalog, routerImageRequest } from "./bitsbytes-image-catalog"
const architecture = { input_modalities: ["text"], output_modalities: ["image"] }
test("dedicated image catalogue accepts raster models and excludes chat-only models", () => {
  expect(
    imageCatalog({
      data: [
        { id: "image", name: "Image", architecture },
        { id: "chat", name: "Chat", architecture: { ...architecture, output_modalities: ["text"] } },
        { id: "jpeg", name: "JPEG", architecture, supported_parameters: { output_format: { values: ["jpeg"] } } },
      ],
    }).map((row) => row.id),
  ).toEqual(["image", "jpeg"])
  expect(() => imageCatalog({ data: [] })).toThrow("bb.error.imageModels")
})
test("OpenRouter requests omit unsupported defaults and reject unsupported explicit options", () => {
  const model = { id: "image", name: "Image", parameters: {} }
  const request = { prompt: "A circle", quality: "medium", size: "auto", background: "opaque" }
  expect(routerImageRequest(model, request)).toEqual({ model: "image", prompt: "A circle" })
  expect(() => routerImageRequest(model, { ...request, size: "1024x1024" })).toThrow("bb.error.imageOptions")
  expect(() => routerImageRequest(model, { ...request, background: "transparent" })).toThrow("bb.error.imageOptions")
  const full = {
    ...model,
    parameters: {
      n: true,
      size: true,
      quality: { values: ["medium"] },
      output_format: { values: ["png"] },
      background: { values: ["transparent"] },
    },
  }
  expect(routerImageRequest(full, { ...request, size: "1024x1024", background: "transparent" })).toEqual({
    model: "image",
    prompt: "A circle",
    n: 1,
    output_format: "png",
    quality: "medium",
    size: "1024x1024",
    background: "transparent",
  })
})

test("editing requires both image input and the reference-image parameter", () => {
  const models = imageCatalog({
    data: [
      { id: "editable", name: "Editable", architecture: { ...architecture, input_modalities: ["text", "image"] }, supported_parameters: { input_references: { type: "array" } } },
      { id: "text", name: "Text only", architecture, supported_parameters: { input_references: { type: "array" } } },
      { id: "missing", name: "Missing parameter", architecture: { ...architecture, input_modalities: ["text", "image"] } },
    ],
  })
  expect(models.filter(model => model.editing).map(model => model.id)).toEqual(["editable"])
  const request = { prompt: "Merge the reference photos", quality: "medium", size: "auto", background: "opaque" }
  const references = ["data:image/png;base64,first", "data:image/jpeg;base64,second"]
  expect(routerImageRequest(models.find(model => model.id === "editable")!, request, references)).toEqual({
    model: "editable", prompt: request.prompt,
    input_references: references.map(url => ({ type: "image_url", image_url: { url } })),
  })
  for (const model of models.filter(model => !model.editing))
    expect(() => routerImageRequest(model, request, references)).toThrow("bb.error.imageEditingUnsupported")
})
