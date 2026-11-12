// The tray icon: the app icon (icon/iconArt.ts) drawn at the tray slot's
// size for 100%, 150% and 200% display scaling, so Windows never has to
// shrink the 256px icon into a blur.

import { nativeImage, type NativeImage } from 'electron'
import { drawIcon } from './icon/iconArt'
import { encodePng } from './icon/png'

const TRAY_SIZE = 16

export function createTrayIcon(): NativeImage {
  const image = nativeImage.createEmpty()
  for (const scaleFactor of [1, 1.5, 2]) {
    const size = Math.round(TRAY_SIZE * scaleFactor)
    image.addRepresentation({ scaleFactor, buffer: encodePng(drawIcon(size), size, size) })
  }
  return image
}
