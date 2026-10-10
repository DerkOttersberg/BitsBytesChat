export function fileType(filename: string, kind?: string) {
  const extension = filename.split(/[\\/]/).at(-1)?.split(".").at(-1)?.toLowerCase()
  if (["doc", "docx", "odt", "rtf"].includes(extension ?? "")) return "word"
  if (["xls", "xlsx", "xlsm", "ods", "csv", "tsv"].includes(extension ?? "")) return "spreadsheet"
  if (["ppt", "pptx", "odp"].includes(extension ?? "")) return "presentation"
  if (extension === "pdf") return "pdf"
  if (["png", "jpg", "jpeg", "webp", "gif", "svg", "avif", "bmp", "ico"].includes(extension ?? "")) return "image"
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "py", "html", "htm", "css", "scss", "md", "mdx", "yaml", "yml", "xml", "toml", "rs", "go", "java", "kt", "swift", "c", "cpp", "h", "cs", "sh", "ps1", "sql", "vue", "svelte"].includes(extension ?? "")) return "code"
  if (kind === "document") return "word"
  if (kind === "html" || kind === "source" || kind === "plan" || kind === "goal") return "code"
  if (kind === "spreadsheet" || kind === "presentation" || kind === "pdf" || kind === "image" || kind === "code") return kind
  return "file"
}
