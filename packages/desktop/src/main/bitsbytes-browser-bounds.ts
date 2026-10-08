type Bounds = { x: number; y: number; width: number; height: number }

// Renderer rectangles are CSS pixels; a native child view uses window DIPs.
// Display scale is already handled by Electron, so only page zoom belongs here.
export function browserBounds(rect: Bounds, zoom: number): Bounds {
  const x = Math.max(0, Math.round(rect.x * zoom))
  const y = Math.max(0, Math.round(rect.y * zoom))
  return {
    x,
    y,
    width: Math.max(0, Math.round((rect.x + rect.width) * zoom) - x),
    height: Math.max(0, Math.round((rect.y + rect.height) * zoom) - y),
  }
}
