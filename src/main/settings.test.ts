import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types'
import { applySettingsUpdate, loadSettings, saveSettings, SETTINGS_FILE_NAME } from './settings'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-settings-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const file = () => join(dir, SETTINGS_FILE_NAME)
const custom: Settings = {
  profile: 'hackathon',
  scanIntervalMinutes: 30,
  notificationsEnabled: false,
  startAtLogin: true,
  actionsEnabled: false,
  rules: { 'long-running': { enabled: true, params: { hours: 12 } } }
}

describe('loadSettings', () => {
  it('returns the defaults when there is no file yet', () => {
    expect(loadSettings(dir)).toEqual({ settings: DEFAULT_SETTINGS, problem: null })
  })

  it('reads back what was saved', () => {
    saveSettings(dir, custom)
    expect(loadSettings(dir)).toEqual({ settings: custom, problem: null })
  })

  it('fills in settings a file from an older version does not have', () => {
    writeFileSync(file(), JSON.stringify({ profile: 'hackathon' }))
    expect(loadSettings(dir).settings).toEqual({ ...DEFAULT_SETTINGS, profile: 'hackathon' })
  })

  it('drops fields it does not know instead of keeping them', () => {
    writeFileSync(file(), JSON.stringify({ ...custom, secretAccessKey: 'nope' }))
    expect(loadSettings(dir).settings).toEqual(custom)
  })

  it('has stopping switched off by default, and for a file written before it existed', () => {
    expect(loadSettings(dir).settings.actionsEnabled).toBe(false)
    const { actionsEnabled: _absent, ...older } = custom
    writeFileSync(file(), JSON.stringify(older))
    expect(loadSettings(dir).settings.actionsEnabled).toBe(false)
  })

  it('remembers that stopping was switched on', () => {
    saveSettings(dir, { ...custom, actionsEnabled: true })
    expect(loadSettings(dir).settings.actionsEnabled).toBe(true)
  })

  it.each([
    ['not JSON', '{ profile: '],
    ['a number out of range', JSON.stringify({ ...custom, scanIntervalMinutes: 1 })],
    ['a wrong type', JSON.stringify({ ...custom, notificationsEnabled: 'yes' })],
    ['not an object', '[]']
  ])('falls back to the defaults for a file that is %s, and says why', (_what, text) => {
    writeFileSync(file(), text)
    const { settings, problem } = loadSettings(dir)
    expect(settings).toEqual(DEFAULT_SETTINGS)
    expect(problem).toEqual(expect.any(String))
  })
})

describe('saveSettings', () => {
  it('writes readable JSON and leaves no temporary file behind', () => {
    saveSettings(dir, custom)
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual(custom)
    expect(readdirSync(dir)).toEqual([SETTINGS_FILE_NAME])
  })

  it('creates the folder if it does not exist', () => {
    const nested = join(dir, 'a', 'b')
    saveSettings(nested, custom)
    expect(existsSync(join(nested, SETTINGS_FILE_NAME))).toBe(true)
  })

  it('replaces the previous file', () => {
    saveSettings(dir, custom)
    saveSettings(dir, { ...custom, scanIntervalMinutes: 60 })
    expect(loadSettings(dir).settings.scanIntervalMinutes).toBe(60)
  })
})

describe('applySettingsUpdate', () => {
  it('changes only the fields given', () => {
    expect(applySettingsUpdate(custom, { scanIntervalMinutes: 5 })).toEqual({ ...custom, scanIntervalMinutes: 5 })
  })

  it('ignores fields given as undefined', () => {
    expect(applySettingsUpdate(custom, { profile: undefined, startAtLogin: undefined })).toEqual(custom)
  })

  it('clears the profile with null', () => {
    expect(applySettingsUpdate(custom, { profile: null }).profile).toBeNull()
  })

  it('replaces the rule settings as a whole', () => {
    const rules = { 'idle-cpu': { enabled: false, params: {} } }
    expect(applySettingsUpdate(custom, { rules }).rules).toEqual(rules)
  })

  it('does not change the settings it was given', () => {
    const before = structuredClone(custom)
    applySettingsUpdate(custom, { scanIntervalMinutes: 5, rules: {} })
    expect(custom).toEqual(before)
  })
})
