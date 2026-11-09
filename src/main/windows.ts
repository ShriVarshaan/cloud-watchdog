// The two windows: the main window (resource list) and the tray popover.
// Both load the same renderer bundle; `?view=` picks which screen to show.

import { join } from 'node:path'
import { app, BrowserWindow, screen, type Rectangle, type WebPreferences } from 'electron'
import { popoverPosition } from './popoverPosition'

type View = 'main' | 'popover'

const POPOVER_SIZE = { width: 360, height: 480 }
// A click on the tray icon first blurs (and hides) an open popover. Ignore
// the click that follows, or the popover would immediately reopen.
const REOPEN_GUARD_MS = 250

/** The built renderer page. The IPC sender check accepts messages from this file only. */
export const RENDERER_FILE = join(import.meta.dirname, '../renderer/index.html')

let mainWindow: BrowserWindow | null = null
let popover: BrowserWindow | null = null
let popoverHiddenAt = 0
let quitting = false

/** Every window uses these. Never relax them; the e2e smoke test checks them. */
export function secureWebPreferences(): WebPreferences {
  return {
    preload: join(import.meta.dirname, '../preload/index.cjs'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: false
  }
}

function loadView(win: BrowserWindow, view: View): Promise<void> {
  // electron-vite sets this when running `npm run dev`.
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer && !app.isPackaged) {
    return win.loadURL(`${devServer}?view=${view}`)
  }
  return win.loadFile(RENDERER_FILE, { query: { view } })
}

/** Lets windows really close when the app is quitting, instead of hiding. */
export function markQuitting(): void {
  quitting = true
}

export function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow()
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 760,
    minHeight: 480,
    show: false,
    title: 'Cloud Watchdog',
    autoHideMenuBar: true,
    webPreferences: secureWebPreferences()
  })
  win.once('ready-to-show', () => win.show())
  // Closing the window hides it; the app keeps watching from the tray.
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      win.hide()
    }
  })
  void loadView(win, 'main')
  return win
}

export function togglePopover(trayBounds: Rectangle): void {
  if (popover?.isVisible()) {
    popover.hide()
    return
  }
  if (Date.now() - popoverHiddenAt < REOPEN_GUARD_MS) return

  if (!popover || popover.isDestroyed()) {
    popover = createPopover()
  }
  const { workArea } = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y })
  const { x, y } = popoverPosition(trayBounds, workArea, POPOVER_SIZE)
  popover.setPosition(x, y)
  popover.show()
  popover.focus()
}

function createPopover(): BrowserWindow {
  const win = new BrowserWindow({
    ...POPOVER_SIZE,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'Cloud Watchdog',
    webPreferences: secureWebPreferences()
  })
  win.on('blur', () => {
    win.hide()
    popoverHiddenAt = Date.now()
  })
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      win.hide()
    }
  })
  void loadView(win, 'popover')
  return win
}
