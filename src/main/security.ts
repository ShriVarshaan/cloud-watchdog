// App-wide security rules for every web page Electron creates.
// The renderer only ever shows our own bundled UI, so it never needs to
// navigate, open windows, embed webviews or ask for device permissions.

import { app, type Session } from 'electron'

export function installWebContentsGuards(): void {
  app.on('web-contents-created', (_event, contents) => {
    // Links to the AWS console are opened by the main process later (M9),
    // never by the page itself.
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  })
}

/**
 * Every permission is refused except writing sanitised text to the
 * clipboard, which the "Copy command" button needs. Reading the clipboard
 * stays refused.
 */
const ALLOWED_PERMISSION = 'clipboard-sanitized-write'

export function hardenSession(session: Session): void {
  session.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === ALLOWED_PERMISSION))
  session.setPermissionCheckHandler((_contents, permission) => permission === ALLOWED_PERMISSION)
}
