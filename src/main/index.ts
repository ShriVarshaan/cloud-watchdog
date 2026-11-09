// Main-process entry point: one instance, lives in the tray, hardened renderer.

import { app, ipcMain, session } from 'electron'
import { listProfileNames } from '../core/aws/profiles'
import type { Db } from '../core/store/db'
import { createStubHandlers, registerIpcHandlers } from './ipcHandlers'
import { hardenSession, installWebContentsGuards } from './security'
import { createSenderCheck } from './senderCheck'
import { openStore } from './store'
import { createTray } from './tray'
import { markQuitting, RENDERER_FILE, showMainWindow } from './windows'

// Tests and development can point the app at a throwaway data folder.
// Ignored in the installed app.
const userDataOverride = process.env['CW_USER_DATA_DIR']
if (userDataOverride && !app.isPackaged) {
  app.setPath('userData', userDataOverride)
}

if (!app.requestSingleInstanceLock()) {
  // Another copy is already running; it will show its window (see below).
  app.quit()
} else {
  app.setAppUserModelId('com.cloudwatchdog.app')
  installWebContentsGuards()

  // The UI's only way in. Every message is sender-checked and validated
  // before a handler runs (see ipcHandlers.ts).
  const isAppPage = createSenderCheck({
    rendererFile: RENDERER_FILE,
    devServerUrl: app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']
  })
  registerIpcHandlers(ipcMain, {
    isTrustedSender: (event) => isAppPage(event.senderFrame),
    handlers: createStubHandlers({ listProfiles: () => listProfileNames() }),
    onError: (channel, error) => console.error(`IPC handler ${channel} failed:`, error)
  })

  let store: Db | null = null

  app.on('second-instance', () => showMainWindow())
  app.on('before-quit', () => markQuitting())
  app.on('will-quit', () => store?.close())
  // Closing every window must not quit: the app keeps running in the tray.
  app.on('window-all-closed', () => {})

  void app.whenReady().then(() => {
    hardenSession(session.defaultSession)
    try {
      store = openStore(app.getPath('userData'))
    } catch (error) {
      // The scan pipeline (M8) decides what the user sees when this fails.
      // Until then the app still starts, without history.
      console.error('Could not open the local database:', error)
    }
    createTray()
    // `--hidden` is used when starting at login (M8): tray only, no window.
    if (!process.argv.includes('--hidden')) showMainWindow()
  })
}
