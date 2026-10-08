export type RecordedSource = {
  id: string
  sourceType: "url" | "document"
  url?: string
  title?: string
  filename?: string
}

// Citations are recorded provider data. Never infer them from answer text or
// turn an unsafe URL into a browser/navigation action.
export function recordedSources(metadata: Record<string, unknown> | undefined) {
  if (!Array.isArray(metadata?.sources)) return []
  const sources = new Map<string, RecordedSource>()
  for (const value of metadata.sources as unknown[]) {
    if (
      !value ||
      typeof value !== "object" ||
      !("id" in value) ||
      typeof value.id !== "string" ||
      !value.id ||
      !("sourceType" in value) ||
      (value.sourceType !== "url" && value.sourceType !== "document")
    )
      continue
    const source: RecordedSource = {
      id: value.id,
      sourceType: value.sourceType,
      title: "title" in value && typeof value.title === "string" ? value.title : undefined,
      filename: "filename" in value && typeof value.filename === "string" ? value.filename : undefined,
    }
    if (source.sourceType === "url" && "url" in value && typeof value.url === "string") {
      const url = URL.parse(value.url)
      if (url && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password) source.url = url.href
    }
    sources.set(source.id, source)
  }
  return [...sources.values()]
}
