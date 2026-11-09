// Draws the tray icon in code: a filled amber dot with a darker ring.
// Placeholder until the real icon arrives with packaging (M11); drawing it
// avoids committing a binary asset that would be replaced anyway.

import { nativeImage, type NativeImage } from 'electron'

const SIZE = 32 // drawn at 2x for a 16px tray slot

export function createTrayIcon(): NativeImage {
  const pixels = Buffer.alloc(SIZE * SIZE * 4) // BGRA, starts fully transparent
  const centre = (SIZE - 1) / 2
  const outer = SIZE / 2 - 1
  const ring = outer - 3

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const distance = Math.hypot(x - centre, y - centre)
      if (distance > outer) continue
      const i = (y * SIZE + x) * 4
      const [r, g, b] = distance > ring ? [146, 64, 14] : [245, 158, 11]
      pixels[i] = b
      pixels[i + 1] = g
      pixels[i + 2] = r
      pixels[i + 3] = 255
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: SIZE, height: SIZE, scaleFactor: 2 })
}
