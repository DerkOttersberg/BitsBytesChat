import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { copyFile, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

export async function repairPythonHome(root: string, environment: string, version = "3.12.11") {
  const path = join(root, "runtime", environment, "pyvenv.cfg")
  const source = await readFile(path, "utf8").catch(() => "")
  const home = source.match(/^home\s*=\s*(.+)$/m)?.[1]?.trim()
  if (!home || existsSync(join(home, "python.exe"))) return false
  const major = version.split(".").slice(0, 2).join(".")
  if (source.match(/^(?:version_info|version)\s*=\s*(\d+\.\d+)/m)?.[1] !== major) return false
  const installed = join(root, "runtime", "python", `cpython-${version}-windows-x86_64-none`)
  if (!existsSync(join(installed, "python.exe"))) return false
  // uv's Windows launcher reads this path; preserve packages and the original config.
  await copyFile(path, path + ".recovery-" + randomUUID())
  await writeFile(path, source.replace(/^home\s*=\s*.+$/m, () => `home = ${installed}`).replace(/^executable\s*=\s*.+$/m, () => `executable = ${join(installed, "python.exe")}`))
  return true
}
