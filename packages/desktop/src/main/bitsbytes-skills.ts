import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, extname, join, resolve } from "node:path"
import { existsSync } from "node:fs"
import { fileHash } from "./bitsbytes-file-hash"
import type { Skill } from "../bitsbytes/types"

export async function saveSkill(directory: string, skill: Skill, forceRevision = false) {
  await mkdir(directory, { recursive: true })
  const previous = JSON.parse(
    await readFile(join(directory, "skill.json"), "utf8").catch((error) => {
      if (error.code === "ENOENT") return "{}"
      throw error
    }),
  )
  if (skill.template && !existsSync(skill.template)) throw new Error("bb.error.templateMissing")
  const template = skill.template ? "resources/template" + extname(skill.template) : ""
  const priorInstructions = await readFile(join(directory, "SKILL.md"), "utf8").catch(() => "")
  const priorResources = await packageHashes(join(directory, ".versions", String(previous.revision)))
  const resources = await packageHashes(directory)
  if (skill.template) resources[template] = await fileHash(skill.template)
  const contentChanged =
    forceRevision ||
    !previous.revision ||
    priorInstructions !== skill.instructions ||
    previous.name !== skill.name ||
    previous.defaultPrompt !== skill.defaultPrompt ||
    previous.output !== skill.output ||
    previous.template !== template ||
    JSON.stringify(Object.entries(priorResources).sort()) !== JSON.stringify(Object.entries(resources).sort())
  const revision = Number(previous.revision ?? 0) + (contentChanged ? 1 : 0)
  if (template && resolve(skill.template) !== resolve(directory, template)) {
    await mkdir(dirname(join(directory, template)), { recursive: true })
    await cp(skill.template, join(directory, template))
  }
  await writeFile(join(directory, "SKILL.md"), skill.instructions, "utf8")
  await writeFile(
    join(directory, "skill.json"),
    JSON.stringify(
      {
        name: skill.name,
        defaultPrompt: skill.defaultPrompt,
        enabled: Boolean(skill.enabled),
        template,
        output: skill.output,
        revision,
      },
      null,
      2,
    ),
  )
  if (!contentChanged) return revision
  const version = join(directory, ".versions", String(revision))
  await mkdir(version, { recursive: true })
  for (const entry of await readdir(directory))
    if (entry !== ".versions") await cp(join(directory, entry), join(version, entry), { recursive: true })
  return revision
}

async function packageHashes(directory: string, prefix = ""): Promise<Record<string, string>> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  return Object.assign(
    {},
    ...(await Promise.all(
      entries
        .filter((entry) => prefix !== "" || ![".versions", "SKILL.md", "skill.json"].includes(entry.name))
        .map(async (entry) =>
          entry.isDirectory()
            ? packageHashes(join(directory, entry.name), prefix + entry.name + "/")
            : { [prefix + entry.name]: await fileHash(join(directory, entry.name)) },
        ),
    )),
  )
}
