import { expect, test } from "bun:test"
import { BBJournalWriter } from "./bitsbytes-journal"

test("concurrent saves share a captured snapshot and all wait for its write", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const state = { value: 0 },
    writes: string[] = [],
    acknowledged: number[] = []
  const writer = new BBJournalWriter(
    () => JSON.stringify(state),
    async (source) => {
      writes.push(source)
      entered.resolve()
      await release.promise
    },
  )
  const saves = [1, 2, 3].map((value) => {
    state.value = value
    return writer.save().then(() => {
      acknowledged.push(value)
    })
  })
  await entered.promise
  expect(writes).toEqual(['{"value":3}'])
  expect(acknowledged).toEqual([])
  release.resolve()
  await Promise.all(saves)
  expect(acknowledged).toEqual([1, 2, 3])
})

test("changes during a write stay frozen separately and do not starve earlier callers", async () => {
  const firstEntered = Promise.withResolvers<void>(),
    secondEntered = Promise.withResolvers<void>()
  const firstRelease = Promise.withResolvers<void>(),
    secondRelease = Promise.withResolvers<void>()
  const state = { value: 1 },
    writes: string[] = [],
    acknowledged: number[] = []
  let active = 0,
    peak = 0
  const writer = new BBJournalWriter(
    () => JSON.stringify(state),
    async (source) => {
      active++
      peak = Math.max(peak, active)
      writes.push(source)
      if (writes.length === 1) {
        firstEntered.resolve()
        await firstRelease.promise
      } else {
        secondEntered.resolve()
        await secondRelease.promise
      }
      active--
    },
  )
  const first = writer.save().then(() => {
    acknowledged.push(1)
  })
  await firstEntered.promise
  state.value = 2
  const second = writer.save().then(() => {
    acknowledged.push(2)
  })
  state.value = 3
  const third = writer.save().then(() => {
    acknowledged.push(3)
  })
  expect(writes).toEqual(['{"value":1}'])
  firstRelease.resolve()
  await first
  await secondEntered.promise
  expect(acknowledged).toEqual([1])
  expect(writes).toEqual(['{"value":1}', '{"value":3}'])
  expect(peak).toBe(1)
  secondRelease.resolve()
  await Promise.all([second, third])
  expect(acknowledged).toEqual([1, 2, 3])
})

test("a failed snapshot rejects its callers while later changes can still save", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const state = { value: 1 },
    writes: string[] = []
  const writer = new BBJournalWriter(
    () => JSON.stringify(state),
    async (source) => {
      writes.push(source)
      if (writes.length === 1) {
        entered.resolve()
        await release.promise
        throw new Error("Disk unavailable")
      }
    },
  )
  const first = writer.save()
  const failed = first.then(() => undefined, error => error)
  await entered.promise
  state.value = 2
  const second = writer.save()
  release.resolve()
  expect(await failed).toMatchObject({ message: "Disk unavailable" })
  await second
  expect(writes).toEqual(['{"value":1}', '{"value":2}'])
})

test("serialization failures do not acknowledge a batch or poison a later save", async () => {
  const state = { failed: true },
    writes: string[] = []
  const writer = new BBJournalWriter(
    () => {
      if (state.failed) throw new Error("Invalid state")
      return "Recovered"
    },
    async (source) => {
      writes.push(source)
    },
  )
  await Promise.all([
    expect(writer.save()).rejects.toThrow("Invalid state"),
    expect(writer.save()).rejects.toThrow("Invalid state"),
  ])
  expect(writes).toEqual([])
  state.failed = false
  await writer.save()
  expect(writes).toEqual(["Recovered"])
})

test("a save requested by an acknowledged caller is scheduled after an idle flush", async () => {
  const state = { value: 1 },
    writes: string[] = []
  const writer = new BBJournalWriter(
    () => JSON.stringify(state),
    async (source) => {
      writes.push(source)
    },
  )
  await writer.save().then(() => {
    state.value = 2
    return writer.save()
  })
  expect(writes).toEqual(['{"value":1}', '{"value":2}'])
})
