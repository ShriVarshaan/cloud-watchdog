// Main-process entry point: one instance, lives in the tray, hardened renderer.
// The app's logic is in controller.ts; this file connects it to Electron.

import { join } from 'node:path'
import { app, dialog, ipcMain, powerMonitor, session, shell, type MessageBoxOptions } from 'electron'
import { createClientFactory } from '../core/aws/clients'
import { listProfileNames } from '../core/aws/profiles'
import { openDb, type Db } from '../core/store/db'
import { migrate } from '../core/store/migrations'
import { createRepo } from '../core/store/repo'
import type { ConfirmDialog } from './confirmations'
import { createController } from './controller'
import { createFakeClientFactory, FAKE_PROFILE, fakeConfirmFrom, fakeScenarioFrom } from './fakeAws'
import { registerIpcHandlers } from './ipcHandlers'
import { managesLoginItem } from './loginItem'
import { hardenSession, installWebContentsGuards } from './security'
import { createSenderCheck } from './senderCheck'
import { openStore } from './store'
import { showToasts } from './toasts'
import { createTray, setTrayTooltip } from './tray'
import { broadcast, markQuitting, RENDERER_FILE, showMainWindow, visibleMainWindow } from './windows'

// Tests and development can point the app at a throwaway data folder.
// Ignored in the installed app.
const userDataOverride = process.env['CW_USER_DATA_DIR']
if (userDataOverride && !app.isPackaged) {
  app.setPath('userData', userDataOverride)
}

// A pretend AWS account (see fakeAws.ts), for development and the end-to-end
// tests. Never in the installed app, whatever the environment says.
const fakeScenario = app.isPackaged ? null : fakeScenarioFrom(process.env['WATCHDOG_FAKE_AWS'])

if (!app.requestSingleInstanceLock()) {
  // Another copy is already running; it will show its window (see below).
  app.quit()
} else {
  // Windows only shows toasts for an AppUserModelID that a Start Menu shortcut
  // carries. The installer creates one for the app's id; a development build
  // runs electron.exe, which has no such shortcut, so it uses the exe path,
  // which Windows accepts without one.
  app.setAppUserModelId(app.isPackaged ? 'com.cloudwatchdog.app' : process.execPath)
  installWebContentsGuards()

  const userData = app.getPath('userData')
  const canSetLoginItem = managesLoginItem({
    isPackaged: app.isPackaged,
    userData,
    defaultUserData: join(app.getPath('appData'), app.getName())
  })
  let store: Db
  let storeOnDisk = true
  try {
    store = openStore(userData)
  } catch (error) {
    // Without its database the app still watches the account; it just keeps
    // no history between runs, and it refuses to stop anything, because the
    // record of that would be lost.
    console.error('Could not open the local database; running without history:', error)
    store = openDb(':memory:')
    migrate(store)
    storeOnDisk = false
  }

  /**
   * The confirmation before stopping is switched on, and before each stop.
   * A native dialog: the page cannot draw it, read it or answer it. Cancel is
   * the default button, and closing the dialog means Cancel.
   */
  async function confirm(question: ConfirmDialog): Promise<boolean> {
    const options: MessageBoxOptions = {
      type: 'warning',
      title: 'Cloud Watchdog',
      message: question.message,
      detail: question.detail,
      buttons: ['Cancel', question.confirmLabel],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    }
    const parent = visibleMainWindow()
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    return response === 1
  }
  // The end-to-end tests cannot click a native dialog. Only with the pretend account.
  const fakeConfirm = fakeScenario ? fakeConfirmFrom(process.env['WATCHDOG_FAKE_CONFIRM']) : null

  const controller = createController({
    userDataDir: userData,
    repo: createRepo(store),
    listProfiles: fakeScenario ? async () => [FAKE_PROFILE] : () => listProfileNames(),
    createClients: (profile) => (fakeScenario ? createFakeClientFactory(fakeScenario) : createClientFactory({ profile })),
    emit: broadcast,
    notify: showToasts,
    setTooltip: setTrayTooltip,
    // Only the installed app in its usual data folder registers itself (see loginItem.ts).
    setLoginItem: (enabled) => {
      if (canSetLoginItem) app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
    },
    openExternal: (url) => shell.openExternal(url),
    confirm: (question) => (fakeConfirm === null ? confirm(question) : Promise.resolve(fakeConfirm)),
    actionLogOnDisk: storeOnDisk,
    log: (message, error) => console.error(message, error ?? '')
  })

  // The UI's only way in. Every message is sender-checked and validated
  // before a handler runs (see ipcHandlers.ts).
  const isAppPage = createSenderCheck({
    rendererFile: RENDERER_FILE,
    devServerUrl: app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']
  })
  registerIpcHandlers(ipcMain, {
    isTrustedSender: (event) => isAppPage(event.senderFrame),
    handlers: controller.handlers,
    onError: (channel, error) => console.error(`IPC handler ${channel} failed:`, error)
  })

  app.on('second-instance', () => showMainWindow())
  app.on('before-quit', () => {
    markQuitting()
    controller.stop()
  })
  app.on('will-quit', () => store.close())
  // Closing every window must not quit: the app keeps running in the tray.
  app.on('window-all-closed', () => {})

  void app.whenReady().then(() => {
    hardenSession(session.defaultSession)
    createTray()
    controller.start()
    powerMonitor.on('resume', () => controller.onResume())
    // `--hidden` is passed when Windows starts the app at login: tray only, no window.
    if (!process.argv.includes('--hidden')) showMainWindow()
  })
}
