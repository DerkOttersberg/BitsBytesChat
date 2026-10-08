export function markdownFileIdentity(directory: string, tab: string) {
  return JSON.stringify([directory, tab])
}

/** Resolve an explicit document link without losing Windows drives, UNC hosts or encoded filenames. */
export function markdownLinkPath(path: string, directory: string | undefined, href: string) {
  try {
    const absolute = /^(?:[a-z]:[\\/]|[\\/])/i.test(path)
    if (!absolute && !directory) return
    const base = absolute ? fileURL(path) : new URL(encodePath(path), fileURL(directory! + "/"))
    const link = /^[a-z]:[\\/]/i.test(href) ? fileURL(href) : new URL(href.replaceAll("\\", "/"), base)
    if (link.protocol !== "file:" || link.username || link.password) return
    const decoded = decodeURIComponent(link.pathname)
    return link.hostname ? `//${link.hostname}${decoded}` : decoded.replace(/^\/([a-z]:)/i, "$1")
  } catch { return }
}

function encodePath(path: string) {
  return path.replaceAll("\\", "/").split("/").map(part => /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part)).join("/")
}

function fileURL(path: string) {
  const normalized = path.replaceAll("\\", "/")
  if (normalized.startsWith("//")) return new URL("file:" + encodePath(normalized))
  return new URL("file:///" + encodePath(normalized).replace(/^\/+/, ""))
}
