// Runs in the sandboxed renderer before the page loads, with access to a
// small part of Electron. It exposes a fixed, named API (never raw
// ipcRenderer) through contextBridge, so the page cannot send arbitrary
// messages to the main process.

import { contextBridge } from 'electron'
import type { WatchdogApi } from '../shared/api'

const api: WatchdogApi = Object.freeze({ apiVersion: 1 })

contextBridge.exposeInMainWorld('watchdog', api)
