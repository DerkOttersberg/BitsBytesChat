import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, writeFile, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { saveSkill } from "./bitsbytes-skills"
import type { Skill } from "../bitsbytes/types"

test("enable changes do not create versions; content and resource edits preserve earlier snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bb-skill-test-"))
  const skill: Skill = {
    id: "sample",
    name: "Sample",
    instructions: "Summarize the input.",
    defaultPrompt: "",
    enabled: true,
    template: "",
    output: "",
    revision: 0,
    versions: [],
    files: [],
  }
  try {
    expect(await saveSkill(directory, skill)).toBe(1)
    expect(await saveSkill(directory, { ...skill, enabled: false })).toBe(1)
    expect(await saveSkill(directory, { ...skill, enabled: true })).toBe(1)
    expect(await readdir(join(directory, ".versions"))).toEqual(["1"])
    const edited = { ...skill, instructions: "Translate the input." }
    expect(await saveSkill(directory, edited)).toBe(2)
    expect(await readFile(join(directory, ".versions/1/SKILL.md"), "utf8")).toBe(skill.instructions)
    await mkdir(join(directory, "resources"))
    await writeFile(join(directory, "resources/reference.txt"), "New reference")
    expect(await saveSkill(directory, edited)).toBe(3)
    expect(await saveSkill(directory, { ...edited, enabled: false })).toBe(3)
    expect(await readFile(join(directory, ".versions/3/resources/reference.txt"), "utf8")).toBe("New reference")
    expect(await saveSkill(directory, skill, true)).toBe(4)
    expect(await readFile(join(directory, ".versions/4/SKILL.md"), "utf8")).toBe(skill.instructions)
    expect(await readFile(join(directory, ".versions/2/SKILL.md"), "utf8")).toBe(edited.instructions)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("template edits create versions while unchanged saves preserve the previous revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bb-skill-template-"))
  try {
    const path = join(directory, "source.docx")
    await writeFile(path, "first template")
    const skill: Skill = {
      id: "sample",
      name: "Sample",
      instructions: "Fill the template.",
      defaultPrompt: "",
      enabled: true,
      template: path,
      output: "",
      revision: 0,
      versions: [],
      files: [],
    }
    expect(await saveSkill(join(directory, "skill"), skill)).toBe(1)
    expect(await saveSkill(join(directory, "skill"), skill)).toBe(1)
    await writeFile(path, "second template")
    expect(await saveSkill(join(directory, "skill"), skill)).toBe(2)
    expect(await readFile(join(directory, "skill/.versions/1/resources/template.docx"), "utf8")).toBe("first template")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("scripts, references and assets create immutable revisions while enable toggles do not", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bb-skill-package-"))
  const skill: Skill = {
    id: "sample",
    name: "Sample",
    instructions: "Follow the package workflow.",
    defaultPrompt: "",
    enabled: true,
    template: "",
    output: "",
    revision: 0,
    versions: [],
    files: [],
  }
  const files = ["scripts/helper.py", "references/SKILL.md", "assets/nested/example.txt"]
  try {
    for (const file of files) {
      await mkdir(dirname(join(directory, file)), { recursive: true })
      await writeFile(join(directory, file), "original " + file)
    }
    expect(await saveSkill(directory, skill)).toBe(1)
    for (const [index, file] of files.entries()) {
      await writeFile(join(directory, file), "updated " + file)
      const revision = index + 2
      expect(await saveSkill(directory, skill)).toBe(revision)
      expect(await saveSkill(directory, { ...skill, enabled: false })).toBe(revision)
      expect(await saveSkill(directory, skill)).toBe(revision)
      expect(await readFile(join(directory, ".versions", String(revision - 1), file), "utf8")).toBe("original " + file)
      expect(await readFile(join(directory, ".versions", String(revision), file), "utf8")).toBe("updated " + file)
    }
    await rm(join(directory, files[0]))
    expect(await saveSkill(directory, skill)).toBe(5)
    expect(await readFile(join(directory, ".versions/4", files[0]), "utf8")).toBe("updated " + files[0])
    expect(await readdir(join(directory, ".versions"))).toEqual(["1", "2", "3", "4", "5"])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
