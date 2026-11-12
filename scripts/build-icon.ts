// Writes the app icon files from the drawing in src/main/icon/iconArt.ts:
//
//   build/icon.ico   every size Windows asks for, for the exe, installer and shortcuts
//   build/icon.png   512px, for the README
//
//   npm run build-icon
//
// The output is committed, so `npm run dist` needs no extra step. Run this
// again after changing the drawing.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { drawIcon } from '../src/main/icon/iconArt.ts'
import { encodeIco, encodePng } from '../src/main/icon/png.ts'

const OUT_DIR = 'build'
// The sizes Windows picks from for taskbar, Start, Explorer views and the installer, at 100 to 200% scaling.
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]

const png = (size: number): Buffer => encodePng(drawIcon(size), size, size)

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, 'icon.ico'), encodeIco(ICO_SIZES.map((size) => ({ size, png: png(size) }))))
writeFileSync(join(OUT_DIR, 'icon.png'), png(512))
console.log(`Wrote ${join(OUT_DIR, 'icon.ico')} (${ICO_SIZES.join(', ')} px) and ${join(OUT_DIR, 'icon.png')} (512 px)`)
