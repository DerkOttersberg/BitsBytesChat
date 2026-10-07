#!/usr/bin/env bun
import { $ } from "bun"

import { cp } from "node:fs/promises"

await cp("icons/bitsbytes", "resources/icons", { recursive: true })

await $`cd ../opencode && bun script/build-node.ts`.env({ ...process.env, OPENCODE_VERSION: "1.18.34", OPENCODE_CHANNEL: "latest" })
// BitsBytes uses the embedded OpenCode server and does not need the upstream preview CLI.
