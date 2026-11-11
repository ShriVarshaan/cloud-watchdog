// The two windows: the main window (resource list) and the tray popover.
// Both load the same renderer bundle; `?view=` picks which screen to show.

import { release } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, screen, type Rectangle, type WebPreferences } from 'electron'
import type { IpcEventChannel, IpcEvents } from '../shared/ipc'
import { popoverPosition } from './popoverPosition'
import { supportsMica, titleBarOverlay, windowBackground } from './windowChrome'

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

/** Whether the main window is drawn on Mica. The page makes its sidebar transparent when it is. */
const mica = supportsMica(process.platform, release())

/** `focus` names a resource key the page should show (after a toast is clicked). */
function loadView(win: BrowserWindow, view: View, focus?: string): Promise<void> {
  const query: Record<string, string> = { view }
  if (focus) query['focus'] = focus
  if (view === 'main' && mica) query['material'] = 'mica'
  // electron-vite sets this when running `npm run dev`.
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer && !app.isPackaged) {
    return win.loadURL(`${devServer}?${new URLSearchParams(query).toString()}`)
  }
  return win.loadFile(RENDERER_FILE, { query })
}

/** Sends a main -> renderer event to every open window. */
export function broadcast<C extends IpcEventChannel>(channel: C, payload: IpcEvents[C]): void {
  for (const win of [mainWindow, popover]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** The main window if it is open and showing, for dialogs that belong to it. */
export function visibleMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : null
}

/** Lets windows really close when the app is quitting, instead of hiding. */
export function markQuitting(): void {
  quitting = true
}

/** Shows the main window, opened on `focusResourceKey` when one is given. */
export function showMainWindow(focusResourceKey: string | null = null): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow(focusResourceKey ?? undefined)
  } else if (focusResourceKey) {
    void loadView(mainWindow, 'main', focusResourceKey)
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createMainWindow(focus?: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 760,
    minHeight: 480,
    show: false,
    title: 'Cloud Watchdog',
    autoHideMenuBar: true,
    // The page draws its own toolbar; Windows keeps drawing the window buttons over it.
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(nativeTheme.shouldUseDarkColors),
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors, mica),
    ...(mica ? { backgroundMaterial: 'mica' as const } : {}),
    webPreferences: secureWebPreferences()
  })
  win.once('ready-to-show', () => win.show())
  // Follow the switch between light and dark mode.
  const followTheme = () => {
    if (win.isDestroyed()) return
    win.setTitleBarOverlay(titleBarOverlay(nativeTheme.shouldUseDarkColors))
    if (!mica) win.setBackgroundColor(windowBackground(nativeTheme.shouldUseDarkColors, false))
  }
  nativeTheme.on('updated', followTheme)
  win.on('closed', () => nativeTheme.off('updated', followTheme))
  // Closing the window hides it; the app keeps watching from the tray.
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      win.hide()
    }
  })
  void loadView(win, 'main', focus)
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
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors, false),
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
