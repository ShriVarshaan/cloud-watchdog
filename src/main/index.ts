// Main-process entry point: one instance, lives in the tray, hardened renderer.

import { app, session } from 'electron'
import { hardenSession, installWebContentsGuards } from './security'
import { createTray } from './tray'
import { markQuitting, showMainWindow } from './windows'

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

  app.on('second-instance', () => showMainWindow())
  app.on('before-quit', () => markQuitting())
  // Closing every window must not quit: the app keeps running in the tray.
  app.on('window-all-closed', () => {})

  void app.whenReady().then(() => {
    hardenSession(session.defaultSession)
    createTray()
    // `--hidden` is used when starting at login (M8): tray only, no window.
    if (!process.argv.includes('--hidden')) showMainWindow()
  })
}
