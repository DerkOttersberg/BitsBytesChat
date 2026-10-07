import { $ } from "bun"
await $`${process.execPath} x --no-install electron-vite build`.env({ ...process.env, OPENCODE_CHANNEL: "prod" })
