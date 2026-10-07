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
      child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error("bb.error.artifactSetup")))
    }).finally(() => { this.installing = undefined })
    return this.installing
  }
  async call<T = Record<string, unknown>>(action: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Error("bb.error.interrupted")
    if (!existsSync(this.python)) await this.setup()
    await repairPythonHome(this.root, "artifacts")
    return JSON.parse(await this.execute(["-u", join(this.assets, "artifact_worker.py"), action], JSON.stringify(args), signal)) as T
  }
  async script(code: string, directory: string, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error("bb.error.interrupted")
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
    if (signal?.aborted) return Promise.reject(new Error("bb.error.interrupted"))
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.python, args, { windowsHide: true, cwd, env: { ...process.env, PYTHONUTF8: "1", MPLBACKEND: "Agg", BITSBYTES_DATA: this.root }, stdio: "pipe" })
      const output: Buffer[] = []
      let bytes = 0, diagnostic = Buffer.alloc(0), failure: Error | undefined
      const fail = (error: Error) => {
        if (failure) return
        failure = error
        if (child.pid && !child.killed) child.kill()
        // A descendant can inherit output handles after the helper exits. Stop
        // and deadlines release our pipes instead of waiting for that descendant.
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
      }
      const timer = setTimeout(() => fail(new Error("bb.error.previewTimeout")), 180000)
      const abort = () => fail(new Error("bb.error.interrupted"))
      signal?.addEventListener("abort", abort, { once: true })
      child.stdout.on("data", (chunk: Buffer) => {
        if (failure) return
        bytes += chunk.length
        if (bytes > 2e6) return fail(new Error("bb.error.artifactOutputLimit"))
        output.push(chunk)
      })
      child.stderr.on("data", chunk => { diagnostic = Buffer.concat([diagnostic, chunk]).subarray(-1e5) })
      child.once("error", fail)
      child.stdin.once("error", fail)
      // Process exit can precede the final output bytes. Close also runs after a
      // failed spawn, and after a cancelled child releases its working directory.
      child.once("close", code => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort)
        if (failure) return reject(failure)
        if (code !== 0) return reject(new Error(diagnostic.toString().slice(-1500) || "bb.error.previewFailed"))
        resolve(Buffer.concat(output).toString())
      })
      child.stdin.end(input)
    })
  }
}
