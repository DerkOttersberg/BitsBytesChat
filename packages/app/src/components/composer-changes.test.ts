import { expect, test } from "bun:test"
import { composerChanges } from "./composer-changes"

test("turn changes count each latest file once, including binary/rename changes", () => {
  expect(
    composerChanges([
      { file: "a", additions: 2, deletions: 4 },
      { file: "a", additions: 3, deletions: 1 },
      { file: "image.png", additions: 0, deletions: 0 },
    ]),
  ).toEqual({ files: 2, additions: 3, deletions: 1 })
})
test("damaged optional counts never produce NaN or negative totals", () => {
  expect(
    composerChanges([
      { file: "", additions: 3, deletions: 3 },
      { file: "a", additions: NaN, deletions: -3 },
    ]),
  ).toEqual({ files: 1, additions: 0, deletions: 0 })
  expect(composerChanges([])).toEqual({ files: 0, additions: 0, deletions: 0 })
})
