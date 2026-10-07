import assert from "node:assert/strict"
import { mkdir, open, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const root = resolve("../.."),
  folder = join(root, ".tools/qa/preview-memory"),
  source = join(folder, "source.txt")
await mkdir(folder, { recursive: true })
if (process.argv.includes("--create")) {
  const file = await open(source, "w"),
    chunk = Buffer.alloc(1024 * 1024, "a")
  try {
    for (let index = 0; index < 96; index++) await file.write(chunk)
  } finally {
    await file.close()
  }
  console.log("Created synthetic preview fixture", (await stat(source)).size)
} else {
  if (!process.env.BB_PREVIEW_MODULE) throw new Error("Select a compiled artifact module")
  const { BBArtifacts } = await import(pathToFileURL(resolve(process.env.BB_PREVIEW_MODULE)).href)
  const artifacts = new BBArtifacts(folder, "", resolve("resources/bitsbytes"), () => {})
  // Register one known QA snapshot to measure only the actual read boundary,
  // excluding fixture generation, hashing and Python publication from RSS.
  artifacts.items = [
    {
      id: "preview_memory",
      sessionID: "ses_preview",
      path: source,
      source,
      filename: "source.txt",
      revision: 1,
      hash: "fixture",
      kind: "code",
      status: "ready",
      updated: 1,
      pdf: "",
      error: "",
    },
  ]
  assert.equal((await stat(source)).size, 96 * 1024 * 1024)
  const started = performance.now()
  const failure = await artifacts.content("preview_memory").then(
    () => "unexpected success",
    (error) => String(error),
  )
  assert.ok(failure.includes("bb.error.fileTooLarge"))
  const report = {
    node: process.version,
    elapsedMs: performance.now() - started,
    maxRSSKiB: process.resourceUsage().maxRSS,
    sourceBytes: (await stat(source)).size,
    failure,
  }
  await writeFile(
    join(root, ".tools/qa/results", (process.env.BB_PREVIEW_REPORT || "preview-memory") + ".json"),
    JSON.stringify(report, null, 2),
  )
  console.log(JSON.stringify(report))
}
