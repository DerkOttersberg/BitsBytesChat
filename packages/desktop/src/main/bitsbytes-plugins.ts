import { readFile, rename, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { stateRecord } from "./bitsbytes-state"

type Spec = string | [string, Record<string, unknown>]
export type PluginSettings = { plugins: { package: string; enabled: boolean }[]; restartRequired: boolean }
export class BBPluginSettings {
  private restartRequired = false
  constructor(
    private path: string,
    private disabledPath: string,
  ) {}
  async call(action: string, args: Record<string, unknown>): Promise<PluginSettings> {
    const config: unknown = JSON.parse(await readFile(this.path, "utf8"))
    if (!stateRecord(config)) throw new Error("bb.error.pluginConfig")
    const active = requireSpecs(config.plugin ?? [])
    const disabled = await readFile(this.disabledPath, "utf8")
      .then((text) => requireSpecs(JSON.parse(text)))
      .catch((error) => {
        if (error.code === "ENOENT") return []
        throw error
      })
    const rows = new Map<string, { spec: Spec; enabled: boolean }>([
      ...disabled.map((spec) => [packageID(spec), { spec, enabled: false }] as const),
      ...active.map((spec) => [packageID(spec), { spec, enabled: true }] as const),
    ])
    if (action === "list")
      return {
        plugins: [...rows].map(([pkg, row]) => ({ package: pkg, enabled: row.enabled })),
        restartRequired: this.restartRequired,
      }
    if (!["save", "remove"].includes(action)) throw new Error("bb.error.unknownMethod")
    const pkg = pluginPackage(args.package)
    if (action === "remove") rows.delete(pkg)
    if (action === "save") {
      if (typeof args.enabled !== "boolean") throw new Error("bb.error.invalidSettings")
      rows.set(pkg, { spec: rows.get(pkg)?.spec ?? pkg, enabled: args.enabled })
    }
    // Retain every managed spec before updating the engine configuration. A
    // crash between writes can leave an entry disabled, but cannot lose its
    // options or accidentally enable it. Active configuration is authoritative.
    await atomic(
      this.disabledPath,
      [...rows.values()].map((row) => row.spec),
    )
    try {
      await atomic(this.path, {
        ...config,
        plugin: [...rows.values()].filter((row) => row.enabled).map((row) => row.spec),
      })
    } catch (error) {
      await atomic(this.disabledPath, disabled)
      throw error
    }
    this.restartRequired = true
    return { plugins: [...rows].map(([pkg, row]) => ({ package: pkg, enabled: row.enabled })), restartRequired: true }
  }
}
export function pluginPackage(value: unknown) {
  if (typeof value !== "string" || value.length > 2048 || /[\r\n\0]/.test(value))
    throw new Error("bb.error.pluginPackage")
  const pkg = value.trim()
  if (/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9.*^~+<>=|-]+)?$/i.test(pkg)) return pkg
  if (pkg.startsWith("file://")) {
    const url = new URL(pkg)
    if (url.protocol === "file:" && /\.(?:[cm]?js|ts)$/i.test(url.pathname)) return url.href
  }
  throw new Error("bb.error.pluginPackage")
}
function packageID(spec: Spec) {
  return typeof spec === "string" ? spec : spec[0]
}
function validSpec(value: unknown): value is Spec {
  return (
    typeof value === "string" ||
    (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && stateRecord(value[1]))
  )
}
function requireSpecs(value: unknown): Spec[] {
  if (!Array.isArray(value) || !value.every(validSpec)) throw new Error("bb.error.pluginConfig")
  return value
}
async function atomic(path: string, value: unknown) {
  const temp = path + "." + randomUUID() + ".tmp"
  await writeFile(temp, JSON.stringify(value, null, 2))
  await rename(temp, path)
}
