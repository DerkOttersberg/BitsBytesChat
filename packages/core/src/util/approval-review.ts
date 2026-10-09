import path from "node:path"
import { lstat, realpath } from "node:fs/promises"

export type ApprovalDetails = {
  directory: string
  resources: readonly string[]
  metadata?: Readonly<Record<string, unknown>>
}

const contained = (root: string, target: string) => {
  const relative = path.relative(root, target)
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
const protectedPath = (relative: string) =>
  relative
    .split(/[\\/]/)
    .some((segment) =>
      /^(\.git|\.codex|\.opencode|\.ssh|\.aws|\.azure|\.gnupg|\.config|\.npmrc|\.netrc|\.env(?:\..*)?|AGENTS\.md|auth\.json|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519|ecdsa|dsa)(?:\..*)?|.+\.(?:pem|key|p12|pfx))$/i.test(
        segment,
      ),
    )

/** Conservative local review, without a billed model call or shell execution. */
export async function reviewLocalApproval(action: string, details?: ApprovalDetails): Promise<"allow" | "ask"> {
  if (action !== "edit" || !details || !path.isAbsolute(details.directory)) return "ask"
  if (
    !["edit", "write", "patch"].includes(String(details.metadata?.operation)) ||
    details.metadata?.destructive !== false
  )
    return "ask"
  if (!details.resources.length || details.resources.length > 100) return "ask"
  return reviewPaths(details).catch(() => "ask")
}

async function reviewPaths(details: ApprovalDetails): Promise<"allow" | "ask"> {
  const root = path.resolve(details.directory)
  const canonicalRoot = await realpath(root)
  if (!(await lstat(canonicalRoot)).isDirectory()) return "ask"
  for (const resource of details.resources) {
    // Permission wildcards are not exact file identities and cannot authorize writes.
    if (!resource || /[\x00-\x1f*?\[\]{}]/.test(resource)) return "ask"
    const target = path.resolve(root, resource)
    const relative = path.relative(root, target)
    if (
      !relative ||
      !contained(root, target) ||
      protectedPath(relative) ||
      (process.platform === "win32" && /:/.test(relative))
    )
      return "ask"
    const segments = relative.split(path.sep)
    if (
      process.platform === "win32" &&
      segments.some(
        (segment) => /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment),
      )
    )
      return "ask"
    for (let index = 0; index < segments.length; index++) {
      const current = path.join(root, ...segments.slice(0, index + 1))
      const stat = await lstat(current).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
      })
      if (!stat) break
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) return "ask"
      if (index < segments.length - 1 && !stat.isDirectory()) return "ask"
      if (index === segments.length - 1 && !stat.isFile()) return "ask"
      const canonical = await realpath(current)
      if (!contained(canonicalRoot, canonical) || protectedPath(path.relative(canonicalRoot, canonical))) return "ask"
    }
  }
  return "allow"
}
