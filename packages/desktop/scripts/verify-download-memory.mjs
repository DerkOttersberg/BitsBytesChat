import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile, stat, writeFile } from "node:fs/promises"
import { createServer, get } from "node:http"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

if (!process.env.BB_DOWNLOAD_MODULE) throw new Error("Select a compiled mobile module")
const root = resolve("../.."),
  source = join(root, ".tools/qa/preview-memory/source.txt"),
  { BBMobile } = await import(pathToFileURL(resolve(process.env.BB_DOWNLOAD_MODULE)).href),
  size = (await stat(source)).size,
  filename = "Saved 🌿 revision.txt",
  artifact = {
    id: "download_memory",
    sessionID: "ses_download",
    filename,
    path: source,
    source,
    revision: 1,
    hash: "fixture",
    kind: "code",
    mime: "text/plain",
    status: "ready",
    updated: 1,
    pdf: source,
    error: "",
    history: [{ revision: 1, source, pdf: source, hash: "fixture", updated: 1 }],
  },
  mobile = new BBMobile(
    {
      artifacts: {
        items: [artifact],
        read: async () => new Uint8Array(await readFile(source)),
        previewPath: async () => source,
      },
    },
    () => {},
    (value) => value,
    (value) => value,
  ),
  failures = [],
  pending = new Set()
assert.equal(size, 96 * 1024 * 1024)
const server = createServer((request, response) => {
  const operation = mobile
    .file(response, new URL(request.url, "http://localhost"))
    .catch((error) => {
      if (response.destroyed) return
      failures.push(String(error))
      response.statusCode = 400
      response.end("Download failed")
    })
    .finally(() => pending.delete(operation))
  pending.add(operation)
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const address = server.address(),
  url = `http://127.0.0.1:${address.port}/file/download_memory?revision=1`
function download(cancel = false) {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      const hash = createHash("sha256")
      let bytes = 0
      response.on("data", (chunk) => {
        bytes += chunk.length
        hash.update(chunk)
        if (cancel) {
          response.destroy()
          resolve({ cancelled: true, bytes })
        }
      })
      response.on("end", () =>
        resolve({ bytes, hash: hash.digest("hex"), status: response.statusCode, headers: response.headers }),
      )
      response.on("error", (error) => {
        if (!cancel) reject(error)
      })
    })
    request.on("error", reject)
  })
}
async function settle() {
  let timeout
  try {
    await Promise.race([
      Promise.all([...pending]),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Download handler did not settle")), 5000)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}
try {
  const started = performance.now(),
    result = await download()
  await settle()
  assert.equal(result.status, 200)
  assert.equal(result.bytes, size)
  assert.equal(result.headers["content-disposition"], `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
  assert.equal(result.headers["cache-control"], "no-store")
  const measured = { elapsedMs: performance.now() - started, maxRSSKiB: process.resourceUsage().maxRSS }
  const reference = createHash("sha256")
  for await (const chunk of createReadStream(source)) reference.update(chunk)
  assert.equal(result.hash, reference.digest("hex"))
  const cancelled = await download(true)
  await settle()
  assert.ok(cancelled.bytes < size)
  const resumed = await download()
  await settle()
  assert.equal(resumed.hash, result.hash)
  assert.equal(failures.length, 0)
  const report = {
    node: process.version,
    ...measured,
    sourceBytes: size,
    sha256: result.hash,
    cancelledBytes: cancelled.bytes,
    checks: 3,
  }
  await writeFile(
    join(root, ".tools/qa/results", (process.env.BB_DOWNLOAD_REPORT || "download-memory") + ".json"),
    JSON.stringify(report, null, 2),
  )
  console.log(JSON.stringify(report))
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
