// The app icon, drawn in code: a blue rounded plate with a white "runway"
// ring that is three quarters full, the same gauge the tray popover leads
// with. One drawing serves every size, from the 16px tray slot to the 256px
// installer icon, so they never drift apart.
//
// Pure TypeScript with no Electron import: the tray (trayIcon.ts) and the
// build script (scripts/build-icon.ts) both use it.

/** Plate gradient, top to bottom: the accent blue, a little lighter and darker. */
const PLATE_TOP = [59, 149, 255] as const
const PLATE_BOTTOM = [0, 96, 223] as const
/** How much white the unfilled part of the ring adds to the plate. */
const TRACK_OPACITY = 0.3
/** The filled part of the ring: clockwise from 12 o'clock. */
const ARC_SWEEP = 1.5 * Math.PI

/** Every shape below is a signed distance in pixels: negative inside, positive outside. */
function roundedRect(px: number, py: number, centre: number, half: number, radius: number): number {
  const qx = Math.abs(px - centre) - (half - radius)
  const qy = Math.abs(py - centre) - (half - radius)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  return outside + Math.min(Math.max(qx, qy), 0) - radius
}

function ring(dx: number, dy: number, radius: number, width: number): number {
  return Math.abs(Math.hypot(dx, dy) - radius) - width / 2
}

/** The ring from 12 o'clock clockwise through `sweep`, with round ends. */
function arc(dx: number, dy: number, radius: number, width: number, sweep: number): number {
  let angle = Math.atan2(dx, -dy) // clockwise from straight up
  if (angle < 0) angle += 2 * Math.PI
  if (angle <= sweep) return ring(dx, dy, radius, width)
  const startDistance = Math.hypot(dx, dy + radius)
  const endDistance = Math.hypot(dx - radius * Math.sin(sweep), dy + radius * Math.cos(sweep))
  return Math.min(startDistance, endDistance) - width / 2
}

/** How much of a pixel a shape covers, from its signed distance: a one-pixel soft edge. */
function coverage(distance: number): number {
  return Math.min(1, Math.max(0, 0.5 - distance))
}

/** Draws the icon at `size` x `size`, as straight (not premultiplied) RGBA. */
export function drawIcon(size: number): Uint8Array {
  const rgba = new Uint8Array(size * size * 4)
  const centre = size / 2
  // Small sizes keep a one-pixel margin; large ones a proportional one.
  const margin = Math.max(size * 0.0625, size <= 32 ? 0.5 : 0)
  const half = centre - margin
  const corner = size * 0.2
  const radius = size * 0.29
  const width = size * 0.115

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const plate = coverage(roundedRect(px, py, centre, half, corner))
      if (plate === 0) continue

      const t = py / size
      const dx = px - centre
      const dy = py - centre
      const white = Math.max(
        coverage(arc(dx, dy, radius, width, ARC_SWEEP)),
        TRACK_OPACITY * coverage(ring(dx, dy, radius, width))
      )
      const i = (y * size + x) * 4
      for (let channel = 0; channel < 3; channel++) {
        const base = PLATE_TOP[channel]! + (PLATE_BOTTOM[channel]! - PLATE_TOP[channel]!) * t
        rgba[i + channel] = Math.round(base + (255 - base) * white)
      }
      rgba[i + 3] = Math.round(255 * plate)
    }
  }
  return rgba
}
