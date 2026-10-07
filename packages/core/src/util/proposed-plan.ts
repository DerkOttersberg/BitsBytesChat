// Only top-level plan tags are actionable; examples in fenced code stay ordinary text.
export function proposedPlan(text: string) {
  const fence = { marker: "", length: 0 }
  const lines = text.split("\n")
  const start = lines.findIndex(line => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)
    if (marker) {
      if (!fence.marker) { fence.marker = marker[1][0]; fence.length = marker[1].length }
      else if (marker[1][0] === fence.marker && marker[1].length >= fence.length) fence.marker = ""
      return false
    }
    return !fence.marker && /^\s*<proposed_plan>/.test(line)
  })
  if (start < 0) return undefined
  const source = lines.slice(start).join("\n").replace(/^\s*<proposed_plan>/, "")
  const end = source.indexOf("</proposed_plan>")
  return { before: lines.slice(0, start).join("\n"), plan: end < 0 ? source : source.slice(0, end), after: end < 0 ? "" : source.slice(end + 16), complete: end >= 0 }
}
