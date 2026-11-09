// Where to put the tray popover so it sits next to the tray icon.
// Pure function, so it can be unit-tested without a screen.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export const POPOVER_MARGIN = 8

export function popoverPosition(tray: Rect, workArea: Rect, size: Size): { x: number; y: number } {
  const m = POPOVER_MARGIN
  const right = workArea.x + workArea.width
  const bottom = workArea.y + workArea.height

  const minX = workArea.x + m
  const maxX = right - size.width - m
  const minY = workArea.y + m
  const maxY = bottom - size.height - m

  // Tray bounds can be empty on some Windows setups: use the usual corner.
  if (tray.width === 0 || tray.height === 0) {
    return { x: Math.round(maxX), y: Math.round(maxY) }
  }

  const centreX = tray.x + tray.width / 2
  const centreY = tray.y + tray.height / 2

  // The taskbar is whichever side of the work area the tray icon lies outside.
  let x: number
  let y: number
  if (tray.y >= bottom) {
    x = centreX - size.width / 2
    y = maxY
  } else if (tray.y + tray.height <= workArea.y) {
    x = centreX - size.width / 2
    y = minY
  } else if (tray.x + tray.width <= workArea.x) {
    x = minX
    y = centreY - size.height / 2
  } else {
    x = maxX
    y = centreY - size.height / 2
  }

  return {
    x: Math.round(clamp(x, minX, maxX)),
    y: Math.round(clamp(y, minY, maxY))
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
