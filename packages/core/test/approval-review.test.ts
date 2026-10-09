import { expect, test } from "bun:test"
import path from "node:path"
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { reviewLocalApproval } from "@opencode-ai/core/util/approval-review"

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "bitsbytes-approval-"))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("local review allows exact non-destructive in-folder edit/write/patch operations", () =>
  fixture(async (directory) => {
    await mkdir(path.join(directory, "src"))
    await writeFile(path.join(directory, "src", "existing.ts"), "export const value = 1\n")
    for (const operation of ["edit", "write", "patch"])
      expect(
        await reviewLocalApproval("edit", {
          directory,
          resources: ["src/existing.ts", "new/deep/document.md"],
          metadata: { operation, destructive: false },
        }),
      ).toBe("allow")
  }))

test("commands, unknown tools, external scopes and missing provenance always ask", () =>
  fixture(async (directory) => {
    const details = { directory, resources: ["file.md"], metadata: { operation: "edit", destructive: false } }
    for (const action of ["bash", "shell", "external_directory", "delete", "custom_mcp", "computer"])
      expect(await reviewLocalApproval(action, details)).toBe("ask")
    expect(await reviewLocalApproval("edit")).toBe("ask")
    expect(await reviewLocalApproval("edit", { ...details, metadata: {} })).toBe("ask")
    expect(await reviewLocalApproval("edit", { ...details, metadata: { operation: "patch", destructive: true } })).toBe(
      "ask",
    )
    expect(await reviewLocalApproval("edit", { ...details, resources: [] })).toBe("ask")
    expect(await reviewLocalApproval("edit", { ...details, directory: "relative" })).toBe("ask")
  }))

test("wildcards, escapes, protected files and Windows streams never receive automatic approval", () =>
  fixture(async (directory) => {
    for (const resource of [
      "../outside.md",
      path.resolve(directory, "../outside.md"),
      "*",
      "src/*.ts",
      "folder/[file].md",
      ".git/config",
      ".codex/config.toml",
      ".env",
      "config/.env.production",
      "AGENTS.md",
      ".npmrc",
      "auth.json",
      "secret.key",
      "nested.private.key",
      "certificate.prod.pem",
      "id_ed25519",
      "id_rsa.pub",
      "credentials.json",
      ".",
    ])
      expect(
        await reviewLocalApproval("edit", {
          directory,
          resources: [resource],
          metadata: { operation: "write", destructive: false },
        }),
      ).toBe("ask")
    if (process.platform === "win32")
      for (const resource of ["file.md:stream", "NUL.txt", "CON", ".git./config", ".. /outside.md", "new.md "])
        expect(
          await reviewLocalApproval("edit", {
            directory,
            resources: [resource],
            metadata: { operation: "write", destructive: false },
          }),
        ).toBe("ask")
  }))

test("symlink/junction descendants and hardlinked files fall back to the user", () =>
  fixture(async (directory) => {
    const external = path.join(directory, "sibling")
    const root = path.join(directory, "root")
    await mkdir(external)
    await mkdir(root)
    await writeFile(path.join(external, "outside.md"), "kept")
    await symlink(external, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir")
    await link(path.join(external, "outside.md"), path.join(root, "hardlink.md"))
    for (const resource of ["linked/new.md", "linked/outside.md", "hardlink.md"])
      expect(
        await reviewLocalApproval("edit", {
          directory: root,
          resources: [resource],
          metadata: { operation: "edit", destructive: false },
        }),
      ).toBe("ask")
  }))

test("filesystem failures cannot silently become automatic approval", () =>
  fixture(async (directory) => {
    await writeFile(path.join(directory, "not-a-directory"), "kept")
    expect(
      await reviewLocalApproval("edit", {
        directory,
        resources: ["not-a-directory/file.md"],
        metadata: { operation: "write", destructive: false },
      }),
    ).toBe("ask")
    expect(
      await reviewLocalApproval("edit", {
        directory: path.join(directory, "missing"),
        resources: ["file.md"],
        metadata: { operation: "write", destructive: false },
      }),
    ).toBe("ask")
  }))
