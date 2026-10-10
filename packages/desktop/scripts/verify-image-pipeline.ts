import assert from "node:assert/strict"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { BBImages, type ImageConfiguration } from "../src/main/bitsbytes-images"
import { BBArtifacts } from "../src/main/bitsbytes-artifacts"

// Real decoder, artifact snapshots and durable jobs; all inference is loopback.
const root = resolve("../..")
const folder = await mkdtemp(join(root, ".tools/qa/image-pipeline-"))
const python = process.env.BB_QA_PYTHON || join(process.env.LOCALAPPDATA!, "BitsBytesChat/runtime/artifacts/Scripts/python.exe")
const child = spawn(python, ["-c", "from PIL import Image; import sys; from pathlib import Path; p=Path(sys.argv[1]); im=Image.new('RGB',(24,16),'#255478'); im.save(p/'input.jpeg'); im.save(p/'input.webp')", folder], { windowsHide: true, stdio: "pipe" })
child.stdout.resume()
child.stderr.resume()
await new Promise<void>((done, fail) => { child.once("error", fail); child.once("close", code => code === 0 ? done() : fail(Error("Image fixture creation failed"))) })
const artifacts = new BBArtifacts(folder, python, resolve("resources/bitsbytes"), () => {})
artifacts.runtime.python = python
await artifacts.start()
let configuration: ImageConfiguration | undefined
let format = "jpeg"
let submissions = 0
const api = createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json")
  if (request.method === "GET") {
    response.end(JSON.stringify({ data: [{ id: "fixture/raster", name: "Raster", architecture: { input_modalities: ["text"], output_modalities: ["image"] }, supported_parameters: { output_format: { values: ["jpeg", "webp"] } } }] }))
    return
  }
  submissions++
  request.resume()
  response.end(JSON.stringify({ data: [{ b64_json: (await readFile(join(folder, "input." + format))).toString("base64"), media_type: "image/" + format }] }))
})
await new Promise<void>(done => api.listen(0, "127.0.0.1", done))
const address = api.address()
assert(address && typeof address !== "string")
const images = new BBImages(folder, {
  configuration: () => configuration,
  saveConfiguration: async value => { configuration = value },
  openrouterKey: () => "fictional",
  catalogueEndpoint: `http://127.0.0.1:${address.port}/models`,
  endpoint: `http://127.0.0.1:${address.port}/images`,
  normalize: (path, output) => artifacts.runtime.call("normalize_image", { path, output }),
  validate: path => artifacts.runtime.call("validate", { path }),
  publish: (path, sessionID, image, inputID) => artifacts.publish(path, sessionID, image.jobID, inputID, image),
  changed: () => {},
})
const checks: string[] = []
try {
  await images.start()
  await images.configure({ provider: "openrouter", model: "fixture/raster" })
  assert.equal(submissions, 0)
  for (format of ["jpeg", "webp"]) {
    const result = await images.generate({ prompt: "Local format fixture" }, "qa-image", format)
    assert.equal(result.status, "ready", JSON.stringify(result))
    assert.equal(result.artifact?.mime, "image/png")
    assert.deepEqual({ width: result.image?.width, height: result.image?.height }, { width: 24, height: 16 })
    assert.equal((await readFile(result.artifact!.source!)).subarray(0, 8).toString("hex"), "89504e470d0a1a0a")
    assert.equal((await images.generate({ prompt: "Local format fixture" }, "qa-image", format)).artifact?.id, result.artifact?.id)
    checks.push(format.toUpperCase() + " response is decoded, validated and published once as an immutable PNG artifact")
  }
  assert.equal(submissions, 2)
  const recovered = new BBArtifacts(folder, python, resolve("resources/bitsbytes"), () => {})
  recovered.runtime.python = python
  await recovered.start()
  assert.equal(recovered.items.length, 2)
  checks.push("Artifacts survive restart and duplicate deliveries never resubmit inference")
  await mkdir(join(root, ".tools/qa/results"), { recursive: true })
  await writeFile(join(root, ".tools/qa/results/image-pipeline.json"), JSON.stringify({ folder, checks, submissions, paidRequests: false }, null, 2))
  checks.forEach(check => console.log("PASS", check))
} finally {
  api.closeAllConnections()
  await new Promise<void>(done => api.close(() => done()))
}
