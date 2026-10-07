import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { repairPythonHome } from "./bitsbytes-runtime"

export class BBArtifactRuntime {
  python: string
  private installing?: Promise<void>
  constructor(private root: string, private assets: string) { this.python = join(root, "runtime/artifacts/Scripts/python.exe") }
  async setup() {
    if (this.installing) return this.installing
    this.installing = new Promise<void>((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(this.assets, "setup.ps1"), "-ArtifactTools"], { windowsHide: true, stdio: "pipe" })
      child.stdout.resume(); child.stderr.resume()
      child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error("bb.error.artifactSetup")))
    }).finally(() => { this.installing = undefined })
    return this.installing
  }
  async call<T = Record<string, unknown>>(action: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (!existsSync(this.python)) await this.setup()
    await repairPythonHome(this.root, "artifacts")
    return JSON.parse(await this.execute(["-u", join(this.assets, "artifact_worker.py"), action], JSON.stringify(args), signal)) as T
  }
  async script(code: string, directory: string, signal?: AbortSignal) {
    if (!existsSync(this.python)) await this.setup()
    await repairPythonHome(this.root, "artifacts")
    await mkdir(directory, { recursive: true })
    const path = join(directory, `script-${randomUUID()}.py`)
    await writeFile(path, code)
    const output = await this.execute(["-u", path], "", signal, directory)
    await writeFile(path + ".log", output)
    return { output, script: path }
  }
  private execute(args: string[], input: string, signal?: AbortSignal, cwd = this.root) {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.python, args, { windowsHide: true, cwd, env: { ...process.env, PYTHONUTF8: "1", MPLBACKEND: "Agg", BITSBYTES_DATA: this.root }, stdio: "pipe" })
      const output: Buffer[] = [], error: Buffer[] = []
      const timer = setTimeout(() => { child.kill(); reject(new Error("bb.error.previewTimeout")) }, 180000)
      const abort = () => { child.kill(); reject(new Error("bb.error.interrupted")) }
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) abort()
      child.stdout.on("data", chunk => { if (output.reduce((sum, row) => sum + row.length, 0) < 2e6) output.push(chunk) })
      child.stderr.on("data", chunk => { if (error.reduce((sum, row) => sum + row.length, 0) < 1e5) error.push(chunk) })
      child.once("error", reject)
      child.once("exit", code => { clearTimeout(timer); signal?.removeEventListener("abort", abort); if (code === 0) resolve(Buffer.concat(output).toString()); else reject(new Error(Buffer.concat(error).toString().slice(-1500) || "bb.error.previewFailed")) })
      child.stdin.end(input)
    })
  }
}
