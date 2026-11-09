// Runs in the sandboxed renderer before the page loads, with access to a
// small part of Electron. It exposes a fixed, named API (never raw
// ipcRenderer) through contextBridge, so the page cannot send arbitrary
// messages to the main process.
//
// The API is built from the contract in src/shared/ipc.ts: one function per
// entry in API_METHODS, each bound to its own channel. The page chooses a
// method, never a channel name.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { API_EVENTS, API_METHODS, type WatchdogApi } from '../shared/ipc'

const api: Record<string, unknown> = { apiVersion: 1 }

for (const [method, channel] of Object.entries(API_METHODS)) {
  // Exactly one argument is forwarded. The main process validates it.
  api[method] = (input?: unknown) => ipcRenderer.invoke(channel, input)
}

for (const [method, channel] of Object.entries(API_EVENTS)) {
  api[method] = (listener: (payload: unknown) => void) => {
    // The page gets the payload only, not Electron's event object.
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('watchdog', Object.freeze(api) as unknown as WatchdogApi)
