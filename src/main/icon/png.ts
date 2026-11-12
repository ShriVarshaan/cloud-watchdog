// Minimal PNG and ICO writers for the app icon, so the icon needs neither an
// image library nor a committed binary that nobody can regenerate.
// Pure TypeScript with no Electron import (see iconArt.ts).

import { crc32, deflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** Encodes straight RGBA pixels as an 8-bit RGBA PNG. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  const stride = width * 4
  if (rgba.length !== stride * height) {
    throw new Error(`A ${width}x${height} image needs ${stride * height} bytes of RGBA, got ${rgba.length}`)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bits per channel
  header[9] = 6 // colour type: RGBA
  // compression, filter method and interlace stay 0

  // Each scanline starts with its filter type; 0 means "none".
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** Packs square PNGs into one .ico file. Windows Vista and later read PNG entries at every size. */
export function encodeIco(images: ReadonlyArray<{ size: number; png: Buffer }>): Buffer {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)

  let offset = 6 + 16 * images.length
  const entries = images.map(({ size, png }) => {
    if (size < 1 || size > 256) throw new Error(`An icon entry is 1 to 256 pixels, not ${size}`)
    const entry = Buffer.alloc(16)
    entry[0] = size === 256 ? 0 : size // width; 0 means 256
    entry[1] = size === 256 ? 0 : size // height
    // bytes 2 and 3: palette size and reserved, both 0
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += png.length
    return entry
  })
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)])
}
