import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { constants, setPriority } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"

setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
const root = resolve("../..")
const require = createRequire(join(root, "packages/app/package.json"))
const { chromium } = createRequire(join(root, ".tools/qa/package.json"))("playwright")
const folder = join(root, ".tools/qa/markdown-scroll", randomUUID())
await mkdir(folder, { recursive: true })
const source = JSON.stringify(join(root, "packages/app/src/pages/session/markdown-scroll.ts").replaceAll("\\", "/"))
const solid = JSON.stringify(require.resolve("solid-js").replaceAll("\\", "/").replace(/\/server\.c?js$/, "/dev.js"))
const store = JSON.stringify(require.resolve("solid-js/store").replaceAll("\\", "/").replace(/\/server\.c?js$/, "/dev.js"))
await writeFile(join(folder, "fixture.ts"), `
import { createRoot } from ${solid}
import { createStore } from ${store}
import { useMarkdownScroll } from ${source}
let cleanup
window.fixture = {
  mount(identity, delayed = false) {
    cleanup?.()
    document.querySelector('main').replaceChildren()
    createRoot(dispose => {
      cleanup = dispose
      const [state, setState] = createStore({ identity })
      const roots = {}, content = {}
      for (const mode of ['preview', 'source']) {
        const element = document.createElement('div')
        element.id = mode
        element.style.cssText = 'width:360px;height:200px;overflow:auto;border:1px solid'
        element.hidden = mode === 'source'
        const host = document.createElement('div')
        const inner = document.createElement('div')
        inner.style.cssText = 'width:900px;height:' + (delayed ? 30 : 3000) + 'px'
        inner.textContent = 'Saved document content'
        if (mode === 'source') host.attachShadow({ mode: 'open' }).append(inner)
        else host.append(inner)
        element.append(host)
        document.querySelector('main').append(element)
        roots[mode] = element; content[mode] = inner
      }
      useMarkdownScroll(() => state.identity, { preview: () => roots.preview, source: () => roots.source })
      window.current = {
        roots, content,
        identity: value => setState('identity', value),
        show: mode => { roots.preview.hidden = mode !== 'preview'; roots.source.hidden = mode !== 'source' },
        dispose,
      }
    })
  }
}
`)
const built = spawnSync(join(root, ".tools/bun-windows-x64/bun.exe"), ["build", join(folder, "fixture.ts"), "--target=browser", "--outfile=" + join(folder, "fixture.js")], { cwd: root, windowsHide: true, encoding: "utf8" })
assert.equal(built.status, 0, built.stderr)
const bundle = await readFile(join(folder, "fixture.js"))
const view = JSON.stringify(join(root, "packages/app/src/pages/session/markdown-panel.tsx").replaceAll("\\", "/"))
const path = JSON.stringify(join(root, "packages/app/src/pages/session/markdown-path.ts").replaceAll("\\", "/"))
const platform = JSON.stringify(join(root, "packages/app/src/context/platform.tsx").replaceAll("\\", "/"))
const language = JSON.stringify(join(root, "packages/app/src/context/language.tsx").replaceAll("\\", "/"))
await writeFile(join(folder, "view.tsx"), `
import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { MarkdownPreviewSource } from ${view}
import { markdownFileIdentity } from ${path}
import { PlatformProvider } from ${platform}
import { LanguageProvider } from ${language}
const [state, setState] = createStore({ directory: "D:/Project one" })
const text = "# README\\n\\n" + Array.from({ length: 100 }, (_, i) => "Paragraph " + i + " preserves independent view positions.\\n\\n").join("")
window.markdownView = { directory: value => setState("directory", value), identity: () => markdownFileIdentity(state.directory, "file://README.md") }
render(() => <PlatformProvider value={{ platform: "web", openExternal() {}, restart: async () => {}, notify: async () => {} }}><LanguageProvider locale="en">
  <MarkdownPreviewSource identity={markdownFileIdentity(state.directory, "file://README.md")} text={text} source={() => <pre style={{ height: "3000px" }}>{text}</pre>} />
</LanguageProvider></PlatformProvider>, document.querySelector("main"))
`)
await writeFile(join(folder, "view.html"), '<!doctype html><meta charset="utf-8"><style>main{width:400px;height:300px}[hidden]{display:none!important}</style><main></main><script type="module" src="/view.tsx"></script>')
const { build } = await import(pathToFileURL(require.resolve("vite")).href)
const { default: solidPlugin } = await import(pathToFileURL(require.resolve("vite-plugin-solid")).href)
const solidRoot = dirname(require.resolve("solid-js/package.json"))
await build({ configFile: false, root: folder, base: "/view/", publicDir: false, logLevel: "error", plugins: [solidPlugin()], worker: { format: "es" },
  resolve: { alias: [
    { find: "@", replacement: join(root, "packages/app/src") },
    { find: /^solid-js$/, replacement: join(solidRoot, "dist/solid.js") },
    { find: /^solid-js\/web$/, replacement: join(solidRoot, "web/dist/web.js") },
    { find: /^solid-js\/store$/, replacement: join(solidRoot, "store/dist/store.js") },
  ] }, build: { outDir: join(folder, "view-dist"), emptyOutDir: false, rollupOptions: { input: join(folder, "view.html") } } })
const server = createServer(async (request, response) => {
  if (request.url.startsWith("/view/")) {
    const name = request.url === "/view/" ? "view.html" : request.url.slice("/view/".length)
    if (!/^(?:view\.html|assets\/[a-zA-Z0-9_.-]+\.(?:js|css))$/.test(name)) { response.writeHead(404).end(); return }
    const body = await readFile(join(folder, "view-dist", name))
    response.writeHead(200, { "content-type": name.endsWith(".js") ? "application/javascript" : name.endsWith(".css") ? "text/css" : "text/html" })
    response.end(body)
    return
  }
  response.writeHead(200, { "content-type": request.url === "/fixture.js" ? "application/javascript" : "text/html" })
  response.end(request.url === "/fixture.js" ? bundle : '<!doctype html><style>[hidden]{display:none!important}</style><main></main><script src="/fixture.js"></script>')
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
const report = { checks: [], errors: [] }
let browser, page
const pass = label => { report.checks.push(label); console.log("PASS", label) }
try {
  browser = await chromium.launch({ headless: true, channel: "msedge" })
  page = await browser.newPage()
  page.on("pageerror", error => report.errors.push(error.message))
  page.setDefaultTimeout(10000)
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.evaluate(() => window.fixture.mount("document:1"))
  await settle()
  await page.evaluate(() => { window.current.roots.preview.scrollTop = 320; window.current.roots.preview.scrollLeft = 90 })
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("bitsbytes.markdown-scroll:document:1") || "{}").preview?.top === 320)
  await page.evaluate(() => window.current.show("source"))
  await settle()
  await page.evaluate(() => { window.current.roots.source.scrollTop = 700; window.current.roots.source.scrollLeft = 120 })
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("bitsbytes.markdown-scroll:document:1") || "{}").source?.top === 700)
  pass("Preview and Source save independent positions, including source content rendered in a shadow root")

  await page.evaluate(() => window.fixture.mount("document:1"))
  await page.waitForFunction(() => window.current.roots.preview.scrollTop === 320 && window.current.roots.preview.scrollLeft === 90)
  await page.evaluate(() => window.current.show("source"))
  await page.waitForFunction(() => window.current.roots.source.scrollTop === 700 && window.current.roots.source.scrollLeft === 120)
  pass("Both positions survive disposal and reopening the same document revision")

  await page.evaluate(() => window.current.identity("document:2"))
  await page.waitForFunction(() => window.current.roots.source.scrollTop === 0 && window.current.roots.source.scrollLeft === 0)
  await page.evaluate(() => window.current.show("preview"))
  await page.waitForFunction(() => window.current.roots.preview.scrollTop === 0)
  await page.evaluate(() => { window.current.roots.preview.scrollTop = 180 })
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("bitsbytes.markdown-scroll:document:2") || "{}").preview?.top === 180)
  await page.evaluate(() => window.current.identity("document:1"))
  await page.waitForFunction(() => window.current.roots.preview.scrollTop === 320)
  pass("Revision changes start at their own position and restore earlier revision positions")

  await page.evaluate(() => window.fixture.mount("document:1", true))
  await settle()
  await page.evaluate(() => { window.current.content.preview.style.height = "3000px" })
  await page.waitForFunction(() => window.current.roots.preview.scrollTop === 320)
  await page.evaluate(() => window.current.show("source"))
  await settle()
  await page.evaluate(() => { window.current.content.source.style.height = "3000px" })
  await page.waitForFunction(() => window.current.roots.source.scrollTop === 700)
  pass("Delayed Markdown and shadow-root Source layout restore after content becomes tall enough")

  await page.evaluate(() => window.fixture.mount("document:1", true))
  await settle()
  await page.evaluate(() => {
    window.current.roots.preview.dispatchEvent(new WheelEvent("wheel", { deltaY: 30 }))
    window.current.content.preview.style.height = "3000px"
  })
  await settle()
  assert.equal(await page.evaluate(() => window.current.roots.preview.scrollTop), 0)
  await page.evaluate(() => { localStorage.setItem("bitsbytes.markdown-scroll:damaged", "{invalid"); window.fixture.mount("damaged") })
  await settle()
  assert.equal(await page.evaluate(() => window.current.roots.preview.scrollTop), 0)
  assert.deepEqual(report.errors, [])
  pass("User scrolling cancels pending restoration; damaged saved state does not block the document")

  await page.goto(`http://127.0.0.1:${server.address().port}/view/`)
  const preview = page.locator(".bb-markdown-preview")
  const sourceView = page.locator(".bb-markdown-source")
  const showPreview = page.getByRole("button", { name: "Preview", exact: true })
  const showSource = page.getByRole("button", { name: "Source", exact: true })
  await page.getByRole("heading", { name: "README", exact: true }).waitFor()
  await preview.evaluate(element => { element.scrollTop = 240 })
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("bitsbytes.markdown-scroll:" + window.markdownView.identity() + ":working") || "{}").preview?.top === 240)
  await showSource.click()
  await sourceView.evaluate(element => { element.scrollTop = 450 })
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("bitsbytes.markdown-scroll:" + window.markdownView.identity() + ":working") || "{}").source?.top === 450)
  await page.evaluate(() => window.markdownView.directory("D:/Project two"))
  await page.waitForFunction(() => document.querySelector('.bb-preview-modes button[aria-pressed="true"]')?.textContent === "Preview" && document.querySelector(".bb-markdown-preview").scrollTop === 0)
  await preview.evaluate(element => { element.scrollTop = 90 })
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("bitsbytes.markdown-scroll:" + window.markdownView.identity() + ":working") || "{}").preview?.top === 90)
  await page.evaluate(() => window.markdownView.directory("D:/Project one"))
  await page.waitForFunction(() => document.querySelector('.bb-preview-modes button[aria-pressed="true"]')?.textContent === "Source" && document.querySelector(".bb-markdown-source").scrollTop === 450)
  await showPreview.click()
  await page.waitForFunction(() => document.querySelector(".bb-markdown-preview").scrollTop === 240)
  await showSource.click()
  await page.evaluate(() => window.markdownView.directory("D:/Project two"))
  await page.waitForFunction(() => document.querySelector('.bb-preview-modes button[aria-pressed="true"]')?.textContent === "Preview" && document.querySelector(".bb-markdown-preview").scrollTop === 90)
  assert.deepEqual(report.errors, [])
  pass("The actual Markdown component keeps README view mode and both scroll positions separate between projects")
} catch (error) {
  report.failure = String(error.stack ?? error)
  report.state = await page?.evaluate(() => ({ positions: Object.fromEntries(Object.entries(window.current?.roots ?? {}).map(([key, value]) => [key, { top: value.scrollTop, left: value.scrollLeft }])), storage: Object.entries(localStorage) })).catch(() => undefined)
  process.exitCode = 1; console.error(error)
}
finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
  await mkdir(join(root, ".tools/qa/results"), { recursive: true })
  await writeFile(join(root, ".tools/qa/results/markdown-scroll.json"), JSON.stringify(report, null, 2))
}
