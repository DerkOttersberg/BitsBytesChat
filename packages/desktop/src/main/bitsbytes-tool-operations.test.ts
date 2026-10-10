import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { BBToolOperationError, BBToolOperations, BBToolResultError, toolFailureResult, toolOperationMetadata } from "./bitsbytes-tool-operations"
import { ToolOperation } from "@opencode-ai/core/tool-operation"

const folders: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bb-tool-operations-"))
  folders.push(root)
  return { root, operations: new BBToolOperations(root) }
}
afterEach(async () => {
  for (const folder of folders.splice(0)) {
    if (!resolve(folder).startsWith(join(resolve(tmpdir()), "bb-tool-operations-")))
      throw new Error("Unexpected cleanup path")
    await rm(folder, { recursive: true, force: true })
  }
})
const input = { sessionID: "chat", tool: "create_artifact", jobID: "job", outputKey: "report.docx" }
const artifact = { id: "document", revision: 1, hash: "validated-hash" }

test("failed image tools preserve sanitized job diagnostics and failed retry lineage", async () => {
  const f = await fixture()
  const details = { job_id: "image-job", status: "error", diagnostic: { status: 401, message: "Invalid API key" } }
  const original = new BBToolResultError("bb.error.imageAuth", details)
  expect(toolFailureResult(original)).toMatchObject({ ...details, error: "bb.error.imageAuth" })
  const error = await f.operations.run({ ...input, tool: "generate_image" }, async () => { throw original }).catch(error => error)
  const response = toolFailureResult(error)
  expect(response).toMatchObject({ ...details, error: "bb.error.imageAuth" })
  expect(ToolOperation.metadata(response._meta)?.tool).toBe("generate_image")
  const journal = JSON.parse(await readFile(join(f.root, "operations.json"), "utf8"))
  expect(journal[0].status).toBe("failed")
  expect(JSON.stringify(journal)).not.toContain("Invalid API key")
  expect(toolFailureResult(new Error("ordinary"))).toEqual({ error: "ordinary", _meta: undefined })
})

test("durable explicit retry preserves diagnostics and exact output identity", async () => {
  const f = await fixture()
  const error = await f.operations
    .run(input, async () => {
      throw new Error("original diagnostic 🌿")
    })
    .catch((error) => error)
  expect(error).toBeInstanceOf(BBToolOperationError)
  expect(error.message).toBe("original diagnostic 🌿")
  const failed = ToolOperation.metadata(toolOperationMetadata(error))!
  const recovered = await new BBToolOperations(f.root).run(
    { ...input, jobID: "retry", retryOf: failed.attemptID },
    async () => ({ artifacts: [artifact] }),
  )
  const success = ToolOperation.metadata(recovered._meta)!
  expect(success).toMatchObject({ operationID: failed.operationID, retryOf: failed.attemptID, artifacts: [artifact] })
  expect(success.attemptID).not.toBe(failed.attemptID)
  expect(await readFile(join(f.root, "operations.json"), "utf8")).not.toContain("original diagnostic")
})

test("retry ownership rejects a changed chat or output without executing", async () => {
  const f = await fixture()
  const failed = await f.operations
    .run(input, async () => {
      throw new Error("failed")
    })
    .catch((error) => error)
  let executions = 0
  for (const change of [{ outputKey: "other.docx" }, { sessionID: "other" }, { tool: "generate_image" }])
    await expect(
      f.operations.run({ ...input, ...change, retryOf: failed.info.attemptID }, async () => {
        executions++
        return {}
      }),
    ).rejects.toThrow("bb.error.invalidDocument")
  expect(executions).toBe(0)
})

test("preparing polls reuse the billed job lineage until verified output arrives", async () => {
  const f = await fixture()
  const preparing = await f.operations.run(input, async () => ({ status: "preparing", job_id: "durable-provider-job" }))
  const ready = await f.operations.run({ ...input, jobID: "durable-provider-job" }, async () => ({
    status: "ready",
    artifact,
  }))
  expect(ToolOperation.metadata(ready._meta)?.attemptID).toBe(ToolOperation.metadata(preparing._meta)?.attemptID)
  expect(ToolOperation.metadata(preparing._meta)?.artifacts).toBeUndefined()
  expect(ToolOperation.metadata(ready._meta)?.artifacts).toEqual([artifact])
  expect(JSON.parse(await readFile(join(f.root, "operations.json"), "utf8"))).toHaveLength(1)
})

test("damaged optional journals retain readable neighbors and exact recovery copies", async () => {
  const f = await fixture()
  await f.operations.run(input, async () => ({ artifact }))
  const saved = JSON.parse(await readFile(join(f.root, "operations.json"), "utf8"))
  const source = JSON.stringify([...saved, { info: "damaged" }])
  await writeFile(join(f.root, "operations.json"), source)
  await new BBToolOperations(f.root).run({ ...input, jobID: "second", outputKey: "second.docx" }, async () => ({
    artifact,
  }))
  expect(JSON.parse(await readFile(join(f.root, "operations.json"), "utf8"))).toHaveLength(2)
  const backup = (await readdir(f.root)).find((name) => name.startsWith("operations-recovery-"))!
  expect(await readFile(join(f.root, backup), "utf8")).toBe(source)
  await writeFile(join(f.root, "operations.json"), "{broken 🌿")
  await new BBToolOperations(f.root).run(input, async () => ({ artifact }))
  expect((await readdir(f.root)).filter((name) => name.startsWith("operations-recovery-")).length).toBe(2)
})

test("missing output targets retain ordinary validation without speculative lineage", async () => {
  const f = await fixture()
  await expect(
    f.operations.run({ ...input, outputKey: undefined }, async () => {
      throw new Error("files are required")
    }),
  ).rejects.toThrow("files are required")
  expect(await readdir(f.root)).toEqual([])
})

test("optional presentation journal failure never masks a verified artifact result", async () => {
  const f = await fixture()
  const result = await f.operations.run(input, async () => {
    await mkdir(join(f.root, "operations.json.tmp"))
    return { status: "ready", job_id: "already-billed-job", artifact }
  })
  expect(result).toEqual({ status: "ready", job_id: "already-billed-job", artifact })
  expect(result).not.toHaveProperty("_meta")
  const stored = JSON.parse(await readFile(join(f.root, "operations.json"), "utf8"))
  expect(stored[0].status).toBe("running")
})

test("failed durable admission prevents execution and preserves the previous journal", async () => {
  const f = await fixture()
  await f.operations.run(input, async () => ({ artifact }))
  const source = await readFile(join(f.root, "operations.json"), "utf8")
  await mkdir(join(f.root, "operations.json.tmp"))
  let executions = 0
  await expect(
    f.operations.run({ ...input, jobID: "unadmitted", outputKey: "other.docx" }, async () => {
      executions++
      return { artifact }
    }),
  ).rejects.toThrow()
  expect(executions).toBe(0)
  expect(await readFile(join(f.root, "operations.json"), "utf8")).toBe(source)
})

test("an already durable preparing image job survives optional journal failure without invented lineage", async () => {
  const f = await fixture()
  const result = await f.operations.run(
    { ...input, tool: "generate_image", outputKey: "illustration.png" },
    async () => {
      await mkdir(join(f.root, "operations.json.tmp"))
      return { status: "preparing", job_id: "durable-image-job" }
    },
  )
  expect(result).toEqual({ status: "preparing", job_id: "durable-image-job" })
  expect(result).not.toHaveProperty("_meta")
})

test("an unverified success cannot silently bypass failed journal bookkeeping", async () => {
  const f = await fixture()
  await expect(
    f.operations.run(input, async () => {
      await mkdir(join(f.root, "operations.json.tmp"))
      return { status: "ready" }
    }),
  ).rejects.toBeInstanceOf(BBToolOperationError)
})
