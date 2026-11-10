// Shows the toasts planned by notifications.ts as Windows notifications.
// Clicking one opens the main window on its resource.

import { Notification } from 'electron'
import type { Toast } from './notifications'
import { showMainWindow } from './windows'

// A notification that is garbage-collected loses its click handler, so each
// one is kept until it is clicked or closed.
const shown = new Set<Notification>()

export function showToasts(toasts: readonly Toast[]): void {
  if (!Notification.isSupported()) return
  for (const toast of toasts) {
    const notification = new Notification({
      title: toast.title,
      body: toast.body,
      urgency: toast.urgent ? 'critical' : 'normal',
      timeoutType: toast.urgent ? 'never' : 'default'
    })
    const forget = () => shown.delete(notification)
    notification.on('click', () => {
      forget()
      showMainWindow(toast.resourceKey)
    })
    notification.on('close', forget)
    shown.add(notification)
    notification.show()
  }
}
