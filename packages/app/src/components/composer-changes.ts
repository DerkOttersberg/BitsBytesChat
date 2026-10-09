export function composerChanges(diffs: readonly { file: string; additions: number; deletions: number }[]) {
  const byFile = new Map(diffs.filter((row) => row.file).map((row) => [row.file, row]))
  const count = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0)
  return Array.from(byFile.values()).reduce(
    (value, row) => ({
      files: value.files + 1,
      additions: value.additions + count(row.additions),
      deletions: value.deletions + count(row.deletions),
    }),
    { files: 0, additions: 0, deletions: 0 },
  )
}
