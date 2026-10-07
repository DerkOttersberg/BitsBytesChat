import { afterEach, expect, test } from "bun:test"
import Store from "electron-store"
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setImmediate } from "node:timers/promises"
import { createStoreHandlers } from "./store-handlers"

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bitsbytes-store-handlers-"))
  roots.push(root)
  const cache = new Map<string, Store>()
  const getStore = (name: string) => {
    const cached = cache.get(name)
    if (cached) return cached
    const store = new Store({ name, cwd: root, fileExtension: "", accessPropertiesByDotNotation: false })
    cache.set(name, store)
    return store
  }
  return { root, handlers: createStoreHandlers(getStore) }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => {
      if (!resolve(root).startsWith(resolve(join(tmpdir(), "bitsbytes-store-handlers-"))))
        throw new Error("Invalid fixture path")
      return rm(root, { recursive: true, force: true })
    }),
  )
})

test("deleting the last draft key retains the file and preserves the next write", async () => {
  const value = await fixture()
  const name = "opencode.draft.fixture.dat"
  value.handlers.set(name, "prompt", "old draft")
  value.handlers.delete(name, "prompt")
  expect(JSON.parse(await readFile(join(value.root, name), "utf8"))).toEqual({})
  value.handlers.set(name, "prompt", "new draft")
  await setImmediate()
  expect(value.handlers.get(name, "prompt")).toBe("new draft")
  expect(JSON.parse(await readFile(join(value.root, name), "utf8"))).toEqual({ prompt: "new draft" })
  expect(await readdir(value.root)).toEqual([name])
})

test("clearing a workspace store preserves subsequent saved state", async () => {
  const value = await fixture()
  const name = "opencode.workspace.fixture.dat"
  value.handlers.set(name, "old-layout", "old")
  value.handlers.clear(name)
  expect(JSON.parse(await readFile(join(value.root, name), "utf8"))).toEqual({})
  value.handlers.set(name, "layout", "latest")
  await setImmediate()
  expect(value.handlers.get(name, "old-layout")).toBeNull()
  expect(value.handlers.keys(name)).toEqual(["layout"])
  expect(value.handlers.length(name)).toBe(1)
  expect(JSON.parse(await readFile(join(value.root, name), "utf8"))).toEqual({ layout: "latest" })
})

test("rapid emptying and rewriting leaves the latest draft durable without temporary files", async () => {
  const value = await fixture()
  const name = "opencode.draft.rapid.dat"
  for (let index = 0; index < 200; index++) {
    value.handlers.set(name, "prompt", String(index))
    value.handlers.delete(name, "prompt")
    value.handlers.set(name, "prompt", `latest-${index}`)
    if (index % 8 === 0) await setImmediate()
  }
  await setImmediate()
  expect(value.handlers.get(name, "prompt")).toBe("latest-199")
  expect(JSON.parse(await readFile(join(value.root, name), "utf8"))).toEqual({ prompt: "latest-199" })
  expect(await readdir(value.root)).toEqual([name])
})

test("mutation storage faults remain observable instead of being swallowed", async () => {
  const value = await fixture()
  const name = "opencode.draft.failure.dat"
  value.handlers.set(name, "prompt", "saved")
  await rm(join(value.root, name))
  await mkdir(join(value.root, name))
  expect(() => value.handlers.set(name, "prompt", "next")).toThrow()
  expect(() => value.handlers.delete(name, "prompt")).toThrow()
  expect(() => value.handlers.clear(name)).toThrow()
})
