import { describe, expect, it } from 'vitest'
import { drawIcon } from './iconArt'

function at(rgba: Uint8Array, size: number, x: number, y: number): [number, number, number, number] {
  const i = (Math.floor(y) * size + Math.floor(x)) * 4
  return [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!, rgba[i + 3]!]
}

/** A point on the ring's centre line, `degrees` clockwise from 12 o'clock. */
function onRing(size: number, degrees: number): [number, number] {
  const radians = (degrees * Math.PI) / 180
  const radius = size * 0.29
  return [size / 2 + radius * Math.sin(radians), size / 2 - radius * Math.cos(radians)]
}

describe('drawIcon', () => {
  it.each([16, 24, 32, 256])('returns %ipx square RGBA pixels', (size) => {
    expect(drawIcon(size)).toHaveLength(size * size * 4)
  })

  it('leaves the corners outside the rounded plate transparent', () => {
    const rgba = drawIcon(256)
    for (const [x, y] of [
      [0, 0],
      [255, 0],
      [0, 255],
      [255, 255]
    ] as const) {
      expect(at(rgba, 256, x, y)[3]).toBe(0)
    }
  })

  it('fills the plate inside the ring with opaque blue', () => {
    const [r, g, b, a] = at(drawIcon(256), 256, 128, 128)
    expect(a).toBe(255)
    expect(b).toBeGreaterThan(200)
    expect(r).toBeLessThan(80)
    expect(g).toBeLessThan(160)
  })

  it('draws the runway arc in solid white, and the rest of the ring as a faint track', () => {
    const rgba = drawIcon(256)
    // The arc runs clockwise from 12 o'clock for three quarters of the circle.
    for (const degrees of [10, 90, 180, 260]) {
      const [r, g, b] = at(rgba, 256, ...onRing(256, degrees))
      expect(Math.min(r, g, b)).toBeGreaterThan(245)
    }
    // The last quarter is only the track: lighter than the plate, far from white.
    const [r] = at(rgba, 256, ...onRing(256, 315))
    expect(r).toBeGreaterThan(at(rgba, 256, 128, 128)[0] + 30)
    expect(r).toBeLessThan(200)
  })

  it('keeps the arc visible at tray size', () => {
    const rgba = drawIcon(16)
    const [r, g, b, a] = at(rgba, 16, ...onRing(16, 90))
    expect(a).toBe(255)
    expect(Math.min(r, g, b)).toBeGreaterThan(180)
  })

  it('draws the same pixels every time', () => {
    expect(drawIcon(32)).toEqual(drawIcon(32))
  })
})
