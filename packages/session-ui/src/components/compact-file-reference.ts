/** Shorten an absolute Windows file reference for display without changing its source text. */
export function compactFileReference(value: string) {
  if (!/^\/?[A-Za-z]:[\\/]/.test(value)) return
  if (/[\x00-\x1f"'|&<>]/.test(value) || /\s+-\S/.test(value)) return
  if (/\.(?:exe|bat|cmd|com|ps1|sh)\s/i.test(value)) return
  const filename = value.split(/[\\/]/).at(-1)
  if (!filename || !/\.[A-Za-z0-9]{1,8}(?::\d+)?$/.test(filename)) return
  return { filename, path: value }
}
