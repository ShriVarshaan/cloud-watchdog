// Decides whether an IPC message came from the app's own page. The app
// already blocks navigation and new windows (security.ts), so this should
// never fail; it is a second lock in case one of those guards is ever
// bypassed. A message is trusted only if it comes from a top-level frame
// showing the bundled renderer file (or the Vite dev server in development).

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The part of Electron's `WebFrameMain` that is checked. */
export interface SenderFrame {
  url: string
  /** null for a top-level frame. */
  parent: unknown
}

export interface SenderCheckOptions {
  /** Absolute path of the built renderer/index.html. */
  rendererFile: string
  /** Vite dev server URL. Pass it only when the app is not packaged. */
  devServerUrl?: string | undefined
}

function normalise(path: string): string {
  const absolute = resolve(path)
  // Windows paths are case-insensitive.
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

export function createSenderCheck(options: SenderCheckOptions): (frame: SenderFrame | null | undefined) => boolean {
  const rendererPath = normalise(options.rendererFile)
  const devOrigin = options.devServerUrl ? new URL(options.devServerUrl).origin : null

  return (frame) => {
    // No frame (destroyed or mid-navigation) or a nested frame: refuse.
    if (!frame || frame.parent !== null) return false
    try {
      const url = new URL(frame.url)
      if (url.protocol === 'file:') return normalise(fileURLToPath(url)) === rendererPath
      return devOrigin !== null && url.origin === devOrigin
    } catch {
      return false
    }
  }
}
