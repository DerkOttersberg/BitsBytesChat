import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { BBArtifacts } from "./bitsbytes-artifacts"

const integration = process.env.BB_ARTIFACT_PYTHON ? test : test.skip

integration("Markdown source and preview retain the requested immutable revision across source edits and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "bb-markdown-test-"))
  const artifacts = () => {
    const service = new BBArtifacts(root, "", resolve("resources/bitsbytes"), () => {})
    service.runtime.python = process.env.BB_ARTIFACT_PYTHON!
    return service
  }
  try {
    const service = artifacts()
    await service.start()
    const path = join(root, "plan.md")
    const original = "\uFEFF# Plan 🌿\r\n\r\n| Item | State |\r\n| --- | --- |\r\n| First | Ready |\r\n\r\n```ts\r\nconst source = '<script>not executable</script>'\r\n```\r\n"
    const next = "# Revised plan\n\n- [x] First step\n- [ ] Second step\n"
    await writeFile(path, original)
    const first = await service.publish(path, "ses_markdown")
    expect(first.kind).toBe("code")
    await writeFile(path, next)
    expect((await service.content(first.id)).text).toBe(original)
    const second = await service.publish(path, "ses_markdown")
    expect(second.id).toBe(first.id)
    expect(second.revision).toBe(2)
    await writeFile(path, "Unpublished working copy")
    const reopened = artifacts()
    await reopened.start()
    expect((await reopened.content(first.id, { revision: 1 })).text).toBe(original)
    expect((await reopened.content(first.id, { revision: 2 })).text).toBe(next)
    expect((await reopened.content(first.id)).text).toBe(next)
    const copy = join(root, "first-revision.md")
    await reopened.saveCopy(first.id, copy, 1)
    expect(await readFile(copy, "utf8")).toBe(original)
    expect(await readFile(path, "utf8")).toBe("Unpublished working copy")
    await expect(reopened.content(first.id, { revision: 3 })).rejects.toThrow("invalidDocument")
  } finally {
    if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error("Unexpected test directory")
    await rm(root, { recursive: true, force: true })
  }
})
