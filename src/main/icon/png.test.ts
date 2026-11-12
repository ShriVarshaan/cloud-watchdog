import { crc32, inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { encodeIco, encodePng } from './png'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

interface Chunk {
  type: string
  data: Buffer
  crcOk: boolean
}

function chunks(png: Buffer): Chunk[] {
  const out: Chunk[] = []
  let at = 8
  while (at < png.length) {
    const length = png.readUInt32BE(at)
    const type = png.toString('latin1', at + 4, at + 8)
    const data = png.subarray(at + 8, at + 8 + length)
    const crc = png.readUInt32BE(at + 8 + length)
    out.push({ type, data, crcOk: crc === crc32(png.subarray(at + 4, at + 8 + length)) })
    at += 12 + length
  }
  return out
}

/** Undoes the encoder's filter-0 scanlines back into plain RGBA. */
function decodeRgba(png: Buffer, width: number, height: number): Buffer {
  const idat = Buffer.concat(chunks(png).filter((c) => c.type === 'IDAT').map((c) => c.data))
  const raw = inflateSync(idat)
  const stride = width * 4
  const out = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    expect(raw[y * (stride + 1)]).toBe(0)
    raw.copy(out, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1))
  }
  return out
}

function pixels(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37) % 256
  return rgba
}

describe('encodePng', () => {
  it('writes a valid 8-bit RGBA PNG that decodes to the same pixels', () => {
    const rgba = pixels(5, 3)
    const png = encodePng(rgba, 5, 3)

    expect(png.subarray(0, 8)).toEqual(SIGNATURE)
    const list = chunks(png)
    expect(list.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
    expect(list.every((c) => c.crcOk)).toBe(true)

    const ihdr = list[0]!.data
    expect(ihdr.readUInt32BE(0)).toBe(5)
    expect(ihdr.readUInt32BE(4)).toBe(3)
    expect([...ihdr.subarray(8)]).toEqual([8, 6, 0, 0, 0]) // 8 bits, RGBA, deflate, filter 0, no interlace

    expect(decodeRgba(png, 5, 3)).toEqual(Buffer.from(rgba))
  })

  it('refuses pixel data of the wrong length', () => {
    expect(() => encodePng(new Uint8Array(10), 2, 2)).toThrow(/16 bytes/)
  })
})

describe('encodeIco', () => {
  it('packs one PNG per size behind an icon directory', () => {
    const images = [16, 32, 256].map((size) => ({ size, png: encodePng(pixels(size, size), size, size) }))
    const ico = encodeIco(images)

    expect(ico.readUInt16LE(0)).toBe(0) // reserved
    expect(ico.readUInt16LE(2)).toBe(1) // type: icon
    expect(ico.readUInt16LE(4)).toBe(3) // count

    images.forEach(({ size, png }, i) => {
      const entry = 6 + i * 16
      expect(ico[entry]).toBe(size === 256 ? 0 : size) // 0 means 256
      expect(ico[entry + 1]).toBe(size === 256 ? 0 : size)
      expect(ico.readUInt16LE(entry + 4)).toBe(1) // colour planes
      expect(ico.readUInt16LE(entry + 6)).toBe(32) // bits per pixel
      const length = ico.readUInt32LE(entry + 8)
      const offset = ico.readUInt32LE(entry + 12)
      expect(length).toBe(png.length)
      expect(ico.subarray(offset, offset + length)).toEqual(png)
    })
  })

  it('refuses sizes an icon cannot hold', () => {
    expect(() => encodeIco([{ size: 512, png: Buffer.alloc(1) }])).toThrow(/256/)
  })
})
