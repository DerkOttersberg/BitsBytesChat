import { $ } from "bun"
// Direct QA builds must regenerate the embedded engine as well as the renderer.
await import("./prebuild.ts")
await $`${process.execPath} x --no-install electron-vite build`.env({ ...process.env, OPENCODE_CHANNEL: "prod" })
