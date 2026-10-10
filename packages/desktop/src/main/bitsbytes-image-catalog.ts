import { stateRecord } from "./bitsbytes-state"

export type ImageProvider = "openai" | "openrouter"
export type ImageModel = { id: string; name: string; parameters: Record<string, unknown>; editing?: boolean }

export function imageCatalog(value: unknown): ImageModel[] {
  if (!stateRecord(value) || !Array.isArray(value.data)) throw new Error("bb.error.imageModels")
  const models = value.data.flatMap((row) => {
    if (
      !stateRecord(row) ||
      typeof row.id !== "string" ||
      typeof row.name !== "string" ||
      !stateRecord(row.architecture) ||
      !Array.isArray(row.architecture.output_modalities) ||
      !row.architecture.output_modalities.includes("image") ||
      !Array.isArray(row.architecture.input_modalities) ||
      !row.architecture.input_modalities.includes("text")
    )
      return []
    const parameters = stateRecord(row.supported_parameters) ? row.supported_parameters : {}
    const formats = parameters.output_format
    if (stateRecord(formats) && Array.isArray(formats.values) && !formats.values.some((format) => ["png", "jpeg", "webp"].includes(String(format)))) return []
    return [{ id: row.id, name: row.name, parameters, editing: row.architecture.input_modalities.includes("image") && Boolean(parameters.input_references) }]
  })
  if (!models.length) throw new Error("bb.error.imageModels")
  return [...new Map(models.map((model) => [model.id, model])).values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function routerImageRequest(
  model: ImageModel,
  request: { prompt: string; quality: string; size: string; background: string },
  references: readonly string[] = [],
) {
  const body: Record<string, unknown> = { model: model.id, prompt: request.prompt }
  if (references.length) {
    if (!model.editing) throw new Error("bb.error.imageEditingUnsupported")
    body.input_references = references.map(url => ({ type: "image_url", image_url: { url } }))
  }
  if (model.parameters.n) body.n = 1
  const formats = model.parameters.output_format
  if (stateRecord(formats) && Array.isArray(formats.values)) {
    const values = formats.values
    body.output_format = ["png", "jpeg", "webp"].find((format) => values.includes(format))
  }
  const quality = model.parameters.quality
  if (stateRecord(quality) && Array.isArray(quality.values) && quality.values.includes(request.quality))
    body.quality = request.quality
  if (request.size !== "auto") {
    if (!model.parameters.size) throw new Error("bb.error.imageOptions")
    body.size = request.size
  }
  if (request.background === "transparent") {
    const background = model.parameters.background
    if (!stateRecord(background) || !Array.isArray(background.values) || !background.values.includes("transparent"))
      throw new Error("bb.error.imageOptions")
    body.background = "transparent"
  }
  return body
}
