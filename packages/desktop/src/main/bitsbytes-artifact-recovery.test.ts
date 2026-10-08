import { expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { BBArtifacts } from "./bitsbytes-artifacts"

const integration = process.env.BB_ARTIFACT_PYTHON ? test : test.skip
const image = await readFile(new URL("../../icons/bitsbytes/64x64.png", import.meta.url))

for (const fixture of [
  { extension: "png", kind: "image", data: image },
  { extension: "md", kind: "code", data: "# Recoverable document\n" },
  { extension: "html", kind: "html", data: "<!doctype html><title>Recoverable document</title><p>Saved content</p>" },
]) integration(`same-hash ${fixture.kind} publication recovers after the registry becomes writable`, async () => {
  const root = await mkdtemp(join(tmpdir(), "bb-artifact-recovery-"))
  try {
    const staging = join(root, "artifacts.json.tmp")
    let failed = false
    const artifacts = new BBArtifacts(root, "", resolve("resources/bitsbytes"), (_artifact, published) => {
      if (!published || failed) return
      failed = true
      // Fail the final ready-state write after the initial publication was saved.
      mkdirSync(staging)
    })
    artifacts.runtime.python = process.env.BB_ARTIFACT_PYTHON!
    await artifacts.start()
    const path = join(root, "document." + fixture.extension)
    await writeFile(path, fixture.data)
    const first = await artifacts.publish(path, "ses_recovery")
    expect(first.kind).toBe(fixture.kind)
    expect(first.status).toBe("error")
    expect(first.error.length).toBeGreaterThan(0)
    await rmdir(staging)
    const recovered = await artifacts.publish(path, "ses_recovery")
    expect(recovered.id).toBe(first.id)
    expect(recovered.revision).toBe(1)
    expect(recovered.status).toBe("ready")
    expect(recovered.error).toBe("")
    const stored = JSON.parse(await readFile(join(root, "artifacts.json"), "utf8"))
    expect(stored[0]).toMatchObject({ status: "ready", error: "", revision: 1 })
    expect(await readFile(recovered.source!)).toEqual(Buffer.from(fixture.data))
  } finally {
    if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error("Unexpected test directory")
    await rm(root, { recursive: true, force: true })
  }
})
