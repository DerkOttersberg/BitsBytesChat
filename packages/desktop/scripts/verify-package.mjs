import { createRequire } from "node:module"
import { createHash } from "node:crypto"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import assert from "node:assert/strict"

const root = resolve("../.."),
  require = createRequire(import.meta.url)
const version = JSON.parse(await readFile("package.json", "utf8")).version
let asar
try {
  asar = require("@electron/asar")
} catch {
  const packages = await readdir(join(root, "node_modules/.bun"))
  const folder = packages.find((name) => name.startsWith("@electron+asar@"))
  assert.ok(folder, "Build dependencies do not contain the ASAR reader")
  asar = require(join(root, "node_modules/.bun", folder, "node_modules/@electron/asar"))
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const files = async (folder) =>
  (
    await Promise.all(
      (await readdir(folder, { withFileTypes: true })).map((row) =>
        row.isDirectory() ? files(join(folder, row.name)) : [join(folder, row.name)],
      ),
    )
  ).flat()
const packageFolder = resolve(process.env.BB_QA_PACKAGE_DIR || `dist/${version}`)
const archive = join(packageFolder, "win-unpacked/resources/app.asar")
const metadata = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"))
assert.equal(metadata.version, version, "Packaged application version differs from source")
assert.equal(metadata.main, "./out/main/index.js", "Packaged entry point differs from source")
const output = resolve("out"),
  matched = []
for (const path of await files(output)) {
  const name = join("out", relative(output, path))
  assert.equal(
    hash(asar.extractFile(archive, name)),
    hash(await readFile(path)),
    "Stale compiled package file: " + name,
  )
  matched.push(name)
}
const resources = resolve("resources/bitsbytes")
for (const path of await files(resources)) {
  if (path.split(/[\\/]/).includes("__pycache__")) continue
  const name = relative(resources, path)
  assert.equal(
    hash(await readFile(join(packageFolder, "win-unpacked/resources/bitsbytes", name))),
    hash(await readFile(path)),
    "Stale runtime resource: " + name,
  )
  matched.push("bitsbytes/" + name)
}
const installer = await readFile(join(packageFolder, "BitsBytesChat-win-x64.exe"))
const report = {
  version,
  matchedFiles: matched.length,
  installerBytes: installer.length,
  installerSHA256: hash(installer),
}
await writeFile(
  join(root, ".tools/qa/results/" + (process.env.BB_QA_REPORT || "package-" + version.replaceAll(".", "")) + ".json"),
  JSON.stringify(report, null, 2),
)
console.log(JSON.stringify(report))
