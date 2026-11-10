import { build } from "esbuild"
import { cp, mkdir, rm } from "node:fs/promises"
await rm("dist", { recursive: true, force: true })
await mkdir("dist/renderer", { recursive: true })
await build({ entryPoints: ["src/main/index.ts"], outdir: "dist/main", platform: "node", format: "esm", bundle: true, packages: "external", target: "node22", tsconfig: "tsconfig.json" })
await build({ entryPoints: ["src/preload.ts"], outfile: "dist/preload.cjs", platform: "node", format: "cjs", bundle: true, external: ["electron"], tsconfig: "tsconfig.json" })
await build({ entryPoints: ["src/renderer/app.ts"], outfile: "dist/renderer/app.js", platform: "browser", bundle: true, target: "chrome140", tsconfig: "tsconfig.json" })
for (const file of ["index.html", "style.css", "capture.js"]) await cp(`src/renderer/${file}`, `dist/renderer/${file}`)
await cp("vendor/cream-ink-ui", "dist/renderer/cream-ink-ui", { recursive: true })
