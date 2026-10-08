import { expect, test } from "bun:test"
import { browserBounds } from "./bitsbytes-browser-bounds"

test("native browser bounds preserve the panel edges at 100% and 125% page zoom", () => {
  const rect = { x: 332, y: 80, width: 544, height: 712 }
  expect(browserBounds(rect, 1)).toEqual(rect)
  expect(browserBounds(rect, 1.25)).toEqual({ x: 415, y: 100, width: 680, height: 890 })
  // Fractional CSS layout rounds the outer edges, avoiding a one-DIP gap.
  const scaled = browserBounds({ x: 332.4, y: 80.4, width: 543.6, height: 711.6 }, 1.25)
  expect(scaled).toEqual({ x: 416, y: 101, width: 679, height: 889 })
  expect(scaled.x + scaled.width).toBe(1095)
  expect(scaled.y + scaled.height).toBe(990)
})

test("native browser bounds clip an off-window host without negative view dimensions", () => {
  expect(browserBounds({ x: -8, y: -4, width: 48, height: 20 }, 1.25)).toEqual({
    x: 0,
    y: 0,
    width: 50,
    height: 20,
  })
  expect(browserBounds({ x: 0, y: 0, width: 0, height: 0 }, 1.25)).toEqual({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  })
})
