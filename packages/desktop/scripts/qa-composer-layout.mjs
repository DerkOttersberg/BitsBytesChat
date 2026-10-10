import assert from "node:assert/strict"

export async function verifyComposerLayout(main) {
  const geometry = await main.locator('[data-slot="prompt-controls"]').evaluate((controls) => {
    const bounds = controls.getBoundingClientRect()
    const buttons = [...controls.querySelectorAll("button")].flatMap((button) => {
      const rect = button.getBoundingClientRect()
      if (!rect.width || !rect.height || button.closest('[aria-hidden="true"]')) return []
      const label = button.getAttribute("aria-label") || button.getAttribute("data-action") || button.textContent
      const center = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return [
        {
          label,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          fits: rect.x >= bounds.x - 0.5 && rect.right <= bounds.right + 0.5,
          owned: center?.closest("button") === button,
          textFits: [...button.querySelectorAll(".truncate")].every((text) => {
            const span = text.getBoundingClientRect()
            return span.x >= rect.x - 0.5 && span.right <= rect.right + 0.5
          }),
        },
      ]
    })
    const overlaps = buttons.flatMap((button, index) =>
      buttons.slice(index + 1).flatMap((other) => {
        const width = Math.min(button.x + button.width, other.x + other.width) - Math.max(button.x, other.x)
        const height = Math.min(button.y + button.height, other.y + other.height) - Math.max(button.y, other.y)
        return width > 0.5 && height > 0.5 ? [[button.label, other.label]] : []
      }),
    )
    return { width: bounds.width, buttons, overlaps }
  })
  assert.ok(geometry.buttons.length >= 4, "Composer controls must be rendered")
  assert.ok(
    geometry.buttons.every((button) => button.fits && button.owned && button.textFits),
    JSON.stringify(geometry),
  )
  assert.deepEqual(geometry.overlaps, [])
  return geometry
}
