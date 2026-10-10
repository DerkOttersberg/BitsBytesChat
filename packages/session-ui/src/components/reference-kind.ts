/** Classification changes presentation only; sanitization and navigation keep their owners. */
export function referenceKind(href: string) {
  if (/^(?:\/?[A-Za-z]:[\\/]|\\\\|file:\/\/)/.test(href)) return "file" as const
  if (/^https?:\/\//i.test(href)) return "web" as const
  return undefined
}
