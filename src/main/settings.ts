// The user's settings, in settings.json next to the database
// (%APPDATA%/Cloud Watchdog/settings.json). No credentials or secrets are
// ever written here: only a profile NAME, the scan interval and rule options.
//
// The file is validated on load. A missing setting takes its default, an
// unknown field is dropped, and a file that cannot be used at all is replaced
// by the defaults (the problem is reported, so it can be logged).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { SettingsUpdate } from '../shared/ipc'
import { DEFAULT_SETTINGS, SCAN_INTERVAL_MINUTES, type Settings } from '../shared/types'

export const SETTINGS_FILE_NAME = 'settings.json'

const settingsSchema = z.object({
  profile: z.string().min(1).max(128).nullable().default(DEFAULT_SETTINGS.profile),
  scanIntervalMinutes: z
    .number()
    .int()
    .min(SCAN_INTERVAL_MINUTES.min)
    .max(SCAN_INTERVAL_MINUTES.max)
    .default(DEFAULT_SETTINGS.scanIntervalMinutes),
  notificationsEnabled: z.boolean().default(DEFAULT_SETTINGS.notificationsEnabled),
  startAtLogin: z.boolean().default(DEFAULT_SETTINGS.startAtLogin),
  actionsEnabled: z.boolean().default(DEFAULT_SETTINGS.actionsEnabled),
  rules: z
    .record(z.string().min(1).max(64), z.object({ enabled: z.boolean(), params: z.record(z.string().min(1).max(64), z.number()) }))
    .default({})
})

export interface LoadedSettings {
  settings: Settings
  /** Why the file was not used, or null. */
  problem: string | null
}

export function loadSettings(dir: string): LoadedSettings {
  let text: string
  try {
    text = readFileSync(join(dir, SETTINGS_FILE_NAME), 'utf8')
  } catch {
    // First run: there is no file yet.
    return { settings: structuredClone(DEFAULT_SETTINGS), problem: null }
  }

  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { settings: structuredClone(DEFAULT_SETTINGS), problem: `${SETTINGS_FILE_NAME} is not valid JSON; using the defaults.` }
  }
  const parsed = settingsSchema.safeParse(data)
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? '')))].filter(Boolean)
    return {
      settings: structuredClone(DEFAULT_SETTINGS),
      problem: `${SETTINGS_FILE_NAME} has invalid values${fields.length ? ` (${fields.join(', ')})` : ''}; using the defaults.`
    }
  }
  return { settings: parsed.data, problem: null }
}

/** Writes to a temporary file first, so a crash mid-write never leaves a half-written file. */
export function saveSettings(dir: string, settings: Settings): void {
  mkdirSync(dir, { recursive: true })
  const target = join(dir, SETTINGS_FILE_NAME)
  const temporary = `${target}.tmp`
  writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n')
  renameSync(temporary, target)
}

/** The settings with the update applied. Fields that are absent or undefined stay as they were. */
export function applySettingsUpdate(current: Settings, update: SettingsUpdate): Settings {
  const next: Settings = structuredClone(current)
  if (update.profile !== undefined) next.profile = update.profile
  if (update.scanIntervalMinutes !== undefined) next.scanIntervalMinutes = update.scanIntervalMinutes
  if (update.notificationsEnabled !== undefined) next.notificationsEnabled = update.notificationsEnabled
  if (update.startAtLogin !== undefined) next.startAtLogin = update.startAtLogin
  if (update.rules !== undefined) next.rules = structuredClone(update.rules)
  return next
}
