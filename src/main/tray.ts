// The system tray icon: left-click toggles the popover, right-click shows a menu.

import { app, Menu, Tray } from 'electron'
import { createTrayIcon } from './trayIcon'
import { showMainWindow, togglePopover } from './windows'

// Kept at module level so the icon is not garbage-collected and vanish.
let tray: Tray | null = null
let tooltip = 'Cloud Watchdog'

/** The text shown when hovering the icon (built by notifications.ts). */
export function setTrayTooltip(text: string): void {
  tooltip = text
  tray?.setToolTip(text)
}

export function createTray(): Tray {
  tray = new Tray(createTrayIcon())
  tray.setToolTip(tooltip)

  const menu = Menu.buildFromTemplate([
    { label: 'Open Cloud Watchdog', click: () => showMainWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ])

  tray.on('click', (_event, bounds) => togglePopover(bounds))
  tray.on('right-click', () => tray?.popUpContextMenu(menu))
  return tray
}
