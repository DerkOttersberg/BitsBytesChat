import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { mkdir, readFile, readdir, rmdir, stat, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const root = resolve("../.."),
  desktop = resolve(process.env.BB_QA_MAIN || process.cwd())
const { _electron } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const report = { checks: [], errors: [] }
for (const kind of ["damaged", "unreadable", "backup-failure", "ready-save-failure"]) {
  const profile = join(root, ".tools/qa/artifact-registry-" + randomUUID()),
    data = join(profile, "BitsBytesChat"),
    registry = join(data, "artifacts.json"),
    source = join(data, "saved.html"),
    text = "<!doctype html><p>Exact historical source 🌿</p>",
    item = {
      id: "registry_saved",
      sessionID: "ses_registry",
      path: source,
      source,
      filename: "saved.html",
      hash: "saved-fixture",
      revision: 2,
      updated: 1,
      kind: "html",
      mime: "text/html",
      status: kind === "ready-save-failure" ? "queued" : "ready",
      pdf: "",
      error: "",
      history: [
        { revision: 1, hash: "original", source, pdf: "", updated: 1 },
        { revision: 2, hash: "saved-fixture", source, pdf: "", updated: 2 },
      ],
    },
    original = JSON.stringify([item, null]),
    diagnostic = join(profile, "startup-error.json"),
    operations = join(profile, "backup-attempts.json"),
    shim = join(profile, "registry-shim.mjs")
  await mkdir(join(data, "config/opencode"), { recursive: true })
  await symlink(join(process.env.LOCALAPPDATA, "BitsBytesChat/runtime"), join(data, "runtime"), "junction")
  await writeFile(source, text)
  await writeFile(
    join(data, "config/opencode/opencode.json"),
    JSON.stringify({
      model: "registry-qa/fixture",
      provider: {
        "registry-qa": {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "fixture-only" },
          models: { fixture: { name: "Registry fixture", limit: { context: 128000, output: 8192 } } },
        },
      },
    }),
  )
  if (kind === "unreadable") await mkdir(registry)
  else await writeFile(registry, original)
  if (kind === "ready-save-failure") await mkdir(join(data, "artifacts.json.tmp"))
  // This shim changes only the owned diagnostic process. A single failed
  // recovery-copy write must remain an I/O failure, rather than trigger parsing fallback.
  await writeFile(
    shim,
    `import { app, dialog } from "electron";
import { promises, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
app.getAppPath = () => ${JSON.stringify(desktop)};
app.setAsDefaultProtocolClient = () => true;
dialog.showErrorBox = (title, message) => writeFileSync(${JSON.stringify(diagnostic)}, JSON.stringify({ title, message }));
${
  kind === "backup-failure"
    ? `const original = promises.writeFile;
let attempts = 0;
promises.writeFile = async (path, ...args) => {
  if (String(path).startsWith(${JSON.stringify(join(data, "artifacts-recovery-"))})) {
    attempts++;
    writeFileSync(${JSON.stringify(operations)}, JSON.stringify({ attempts }));
    if (attempts === 1) throw new Error("Owned QA recovery-copy failure");
  }
  return original(path, ...args);
};
syncBuiltinESMExports();`
    : ""
}
await import(pathToFileURL(${JSON.stringify(join(desktop, "out/main/index.js"))}).href);
`,
  )
  let app
  try {
    let startupError
    try {
      app = await _electron.launch({
        executablePath: process.env.BB_QA_EXECUTABLE || join(desktop, "node_modules/electron/dist/electron.exe"),
        args: [shim],
        env: { ...process.env, BB_QA_ISOLATED: "1", BB_QA_HIDDEN: "1", LOCALAPPDATA: profile },
        timeout: 30000,
      })
      const page = await app.firstWindow({ timeout: 30000 })
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.hide()))
      page.on("pageerror", (error) => report.errors.push(error.message))
      await page.locator("[contenteditable=true]").first().waitFor({ timeout: 90000 })
      assert.ok(
        ["damaged", "ready-save-failure"].includes(kind),
        "An unreadable registry or failed recovery copy opened as empty state",
      )
      const items = await page.evaluate(() => window.api.bitsbytes.call("artifacts.list"))
      if (kind === "ready-save-failure") {
        assert.equal(items.length, 1)
        assert.equal(items[0].status, "error")
        assert.ok(items[0].error.includes("artifacts.json.tmp"))
        assert.equal(await readFile(registry, "utf8"), original)
        await rmdir(join(data, "artifacts.json.tmp"))
        await page.evaluate(() => window.api.bitsbytes.call("artifact.retry", { id: "registry_saved" }))
        const recovered = JSON.parse(await readFile(registry, "utf8"))
        assert.equal(recovered.length, 1)
        assert.equal(recovered[0].status, "ready")
        assert.equal(recovered[0].error, "")
        assert.equal(recovered[0].revision, 2)
        report.checks.push(
          "A queued direct preview save failure keeps the composer usable and recovers after explicit Retry without changing revision",
        )
      } else assert.deepEqual(items, [item])
      assert.equal(
        (
          await page.evaluate(() =>
            window.api.bitsbytes.call("artifact.content", { id: "registry_saved", revision: 1 }),
          )
        ).text,
        text,
      )
    } catch (error) {
      startupError = error
    }
    if (["damaged", "ready-save-failure"].includes(kind)) {
      if (startupError) throw startupError
      const backups = (await readdir(data)).filter((name) => name.startsWith("artifacts-recovery-"))
      assert.equal(backups.length, 1)
      assert.equal(await readFile(join(data, backups[0]), "utf8"), original)
      if (kind === "damaged") {
        assert.equal(await readFile(registry, "utf8"), original)
        report.checks.push(
          "Damaged registry opens with its valid document, complete historical source and exact recovery copy",
        )
      }
    } else {
      assert.ok(startupError)
      const fatal = JSON.parse(await readFile(diagnostic, "utf8"))
      assert.ok(fatal.message)
      if (kind === "unreadable") {
        assert.equal((await stat(registry)).isDirectory(), true)
        assert.equal((await readdir(data)).filter((name) => name.startsWith("artifacts-recovery-")).length, 0)
        report.checks.push("Unreadable registry fails visibly without adopting or writing empty document history")
      } else {
        assert.equal(JSON.parse(await readFile(operations, "utf8")).attempts, 1)
        assert.equal(await readFile(registry, "utf8"), original)
        report.checks.push(
          "A failed recovery-copy write fails visibly after one attempt and retains the complete original registry",
        )
      }
    }
    assert.equal(await readFile(source, "utf8"), text)
  } finally {
    await app?.close().catch(() => undefined)
  }
}
assert.deepEqual(report.errors, [])
await writeFile(
  join(root, ".tools/qa/results", process.env.BB_ARTIFACT_REGISTRY_REPORT || "artifact-registry.json"),
  JSON.stringify(report, null, 2),
)
for (const check of report.checks) console.log("PASS", check)
