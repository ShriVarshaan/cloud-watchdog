// Whether this copy of the app may add or remove the "start at login" entry.
//
// The entry is one per user, named by the app's id, and points at an exe.
// Only the installed app in its usual data folder may touch it. A development
// build would point it at electron.exe, and a packaged build started with
// `--user-data-dir` (the packaged smoke test) would point it at a build
// folder or, with the setting off, delete the real install's entry.

import { resolve } from 'node:path'

export interface LoginItemContext {
  isPackaged: boolean
  /** The data folder in use: `app.getPath('userData')`. */
  userData: string
  /** Where it would be without `--user-data-dir`: `%APPDATA%\<product name>`. */
  defaultUserData: string
}

function samePath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase()
}

export function managesLoginItem({ isPackaged, userData, defaultUserData }: LoginItemContext): boolean {
  return isPackaged && samePath(userData, defaultUserData)
}
