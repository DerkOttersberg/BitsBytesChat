import assert from "node:assert/strict"

export async function verifyPanelTabs(app, page, artifact, snapshot) {
  const open = async () => {
    await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("bitsbytes:open-artifact", { detail })), {
      id: artifact.id,
      sessionID: artifact.sessionID,
      revision: artifact.revision,
    })
    await page.getByRole("tab", { name: artifact.filename, exact: true }).waitFor()
  }
  const item = () =>
    page
      .locator(".bb-panel-tabs > div")
      .filter({ has: page.getByRole("tab", { name: artifact.filename, exact: true }) })
  const read = () =>
    item().evaluate((element) => {
      const tab = element.querySelector('[role="tab"]')
      const close = element.querySelector(".bb-panel-tab-close")
      const title = element.querySelector(".bb-panel-tab-title")
      const a = tab.getBoundingClientRect(),
        b = close.getBoundingClientRect()
      const strip = element.parentElement.getBoundingClientRect()
      return {
        width: a.width,
        closeInside: b.left >= a.left && b.right <= a.right && b.top >= a.top && b.bottom <= a.bottom,
        nestedButtons: !!tab.querySelector("button"),
        opacity: getComputedStyle(close).opacity,
        mask: getComputedStyle(title).maskImage,
        transition: getComputedStyle(close).transitionDuration,
        focus: document.activeElement === close,
        closeInStrip: b.left >= strip.left && b.right <= strip.right,
      }
    })
  await open()
  await page.keyboard.press("Escape")
  await page.locator('.bb-workspace-chat [contenteditable="true"]').first().focus()
  await page.mouse.move(5, 5)
  await page.waitForTimeout(160)
  const idle = await read()
  assert.equal(idle.opacity, "0")
  assert.equal(idle.mask, "none")
  assert.equal(idle.closeInside, true)
  assert.equal(idle.nestedButtons, false)
  await snapshot("tabs-idle")
  assert.equal(idle.closeInStrip, true, "a newly opened active tab remains in the visible tab strip")
  await item().hover()
  await page.waitForTimeout(160)
  const hovered = await read()
  assert.equal(hovered.opacity, "1")
  assert.match(hovered.mask, /linear-gradient/)
  assert.equal(hovered.width, idle.width)
  await snapshot("tabs-hover")
  await page.mouse.move(5, 5)
  await item().getByRole("tab").focus()
  await page.keyboard.press("Tab")
  const keyboard = await read()
  assert.equal(keyboard.focus, true)
  await page.waitForTimeout(160)
  assert.equal((await read()).opacity, "1")
  await snapshot("tabs-keyboard")
  const other = page.locator('.bb-panel-tabs [role="tab"]').filter({ hasNotText: artifact.filename }).first()
  const otherName = await other.getAttribute("aria-label")
  await other.click()
  await item().hover()
  await item().locator(".bb-panel-tab-close").click()
  await item().waitFor({ state: "detached" })
  assert.equal(await page.getByRole("tab", { name: otherName, exact: true }).getAttribute("aria-selected"), "true")
  await open()
  const geometry = []
  for (const [width, zoom, scheme] of [
    [640, 1, "light"],
    [780, 1.25, "dark"],
    [420, 1, "light"],
  ]) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" })
    await app.evaluate(
      ({ BrowserWindow }, { width, zoom }) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.webContents.setZoomFactor(zoom)
        window.setContentSize(width, 600)
      },
      { width, zoom },
    )
    await item().scrollIntoViewIfNeeded()
    await item().getByRole("tab").focus()
    await page.keyboard.press("Tab")
    const measurement = await page.locator(".bb-panel-header:visible").evaluate((header) => {
      const controls = [
        ...header.querySelectorAll(".bb-panel-add button,.bb-panel-focus button,.bb-panel-collapse button"),
      ]
      const bounds = header.getBoundingClientRect()
      const tabs = header.querySelector(".bb-panel-tabs")
      return {
        width: bounds.width,
        scrollable: getComputedStyle(tabs).overflowX === "auto",
        controlsInside: controls.every((node) => {
          const rect = node.getBoundingClientRect()
          return rect.left >= bounds.left && rect.right <= bounds.right
        }),
      }
    })
    const current = await read()
    assert.equal(measurement.controlsInside, true)
    assert.equal(measurement.scrollable, true)
    assert.equal(current.closeInside, true)
    assert.equal(current.focus, true)
    assert.equal(current.transition, "0s")
    geometry.push({ width, zoom, scheme, ...measurement })
    await snapshot(`tabs-${scheme}-${width}-${zoom}`)
  }
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" })
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.webContents.setZoomFactor(1)
    window.setContentSize(1380, 900)
  })
  await item().locator(".bb-panel-tab-close").focus()
  await page.keyboard.press("Enter")
  await item().waitFor({ state: "detached" })
  assert.ok(
    await page
      .locator('.bb-panel-tabs [role="tab"][aria-selected="true"]')
      .evaluate((element) => element === document.activeElement),
  )
  return { idle, hovered, keyboard, geometry, inactiveClose: true, activeKeyboardClose: true }
}

export async function verifyLastPanelClose(page) {
  const tabs = page.locator('.bb-panel-tabs [role="tab"]')
  while (await tabs.count()) {
    const count = await tabs.count()
    await page.locator(".bb-panel-tabs > div").last().locator(".bb-panel-tab-close").focus()
    await page.keyboard.press("Enter")
    await page.waitForFunction(
      (count) => document.querySelectorAll('.bb-panel-tabs [role="tab"]').length < count,
      count,
    )
  }
  assert.equal(await page.locator(".bb-workspace-panel:visible").count(), 0)
  assert.equal(
    await page
      .locator(".bb-workspace-chat:visible [data-bb-panel-toggle]")
      .evaluate((element) => element === document.activeElement),
    true,
  )
  return { collapsed: true, focusReturnedToChat: true }
}
