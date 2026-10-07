import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const root = resolve("../..")
const desktop = resolve(process.env.BB_QA_MAIN || process.cwd())
const executable = process.env.BB_QA_EXECUTABLE || join(desktop, "node_modules/electron/dist/electron.exe")
const exec = promisify(execFile)
const registration = async () => {
  const result = await exec("reg.exe", ["query", "HKCU\\Software\\Classes\\bitsbytes-chat", "/s"], {
    windowsHide: true,
  }).catch((error) => {
    if (error.code === 1) return { stdout: "absent" }
    throw error
  })
  return result.stdout
}
const original = await registration()
const report = { checks: [], observations: [] }
for (const kind of ["development", "packaged-qa", "packaged-normal"]) {
  const profile = join(root, ".tools/qa/protocol-" + randomUUID())
  await mkdir(profile, { recursive: true })
  const result = join(profile, "protocol.json")
  const shim = join(profile, "shim.mjs")
  // Capture registration at the production startup boundary without writing
  // the registry. Stop before services start; no user application is launched.
  await writeFile(
    shim,
    `import { app, dialog, protocol } from "electron";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const calls = [];
app.getAppPath = () => ${JSON.stringify(desktop)};
Object.defineProperty(app, "isPackaged", { get: () => ${kind !== "development"} });
app.setAsDefaultProtocolClient = (...args) => { calls.push(args); return true };
dialog.showErrorBox = () => {};
protocol.handle = () => { writeFileSync(${JSON.stringify(result)}, JSON.stringify({ kind: ${JSON.stringify(kind)}, calls })); throw new Error("QA protocol checkpoint"); };
await import(pathToFileURL(${JSON.stringify(join(desktop, "out/main/index.js"))}).href);
`,
  )
  const child = spawn(executable, [shim], {
    env: { ...process.env, LOCALAPPDATA: profile, BB_QA_ISOLATED: kind === "packaged-qa" ? "1" : "0" },
    windowsHide: true,
    stdio: "ignore",
  })
  const timer = setTimeout(() => child.kill(), 30000)
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", resolve)
    })
    const observed = JSON.parse(await readFile(result, "utf8"))
    assert.deepEqual(observed.calls, kind === "packaged-normal" ? [["bitsbytes-chat"]] : [])
    assert.equal(await registration(), original)
    report.observations.push(observed)
    report.checks.push(kind + " uses the intended registration policy and leaves the actual Windows registry unchanged")
    console.log("PASS", report.checks.at(-1))
  } finally {
    clearTimeout(timer)
  }
}
await writeFile(
  join(root, ".tools/qa/results", (process.env.BB_PROTOCOL_REPORT || "protocol-isolation") + ".json"),
  JSON.stringify(report, null, 2),
)
