import { randomUUID } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

// Keep damaged bytes recoverable; a broken optional journal must not disable chat.
export async function readState<T>(root: string, name: string, fallback: T, valid: (value: unknown) => boolean): Promise<T> {
  const source = await readFile(join(root, name), "utf8").catch(error => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (source === undefined) return fallback
  try {
    const value: unknown = JSON.parse(source)
    if (!valid(value)) throw new Error("Invalid saved state")
    return value as T
  } catch {
    await writeFile(join(root, `${name}.recovery-${randomUUID()}`), source)
    return fallback
  }
}

export function stateRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
