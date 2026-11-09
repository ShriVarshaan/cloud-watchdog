/// <reference types="vite/client" />
import type { WatchdogApi } from '../shared/ipc'

declare global {
  interface Window {
    /** Exposed by src/preload/index.ts. The renderer's only link to the main process. */
    readonly watchdog: WatchdogApi
  }
}

export {}
