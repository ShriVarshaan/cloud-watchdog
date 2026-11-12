import { describe, expect, it } from 'vitest'
import { managesLoginItem } from './loginItem'

const DEFAULT = 'C:\\Users\\me\\AppData\\Roaming\\Cloud Watchdog'

describe('managesLoginItem', () => {
  it('is true for the installed app using its usual data folder', () => {
    expect(managesLoginItem({ isPackaged: true, userData: DEFAULT, defaultUserData: DEFAULT })).toBe(true)
  })

  it('ignores letter case and a trailing separator, as Windows paths do', () => {
    const userData = 'c:\\users\\ME\\AppData\\Roaming\\cloud watchdog\\'
    expect(managesLoginItem({ isPackaged: true, userData, defaultUserData: DEFAULT })).toBe(true)
  })

  it('is false for a development build, which would register electron.exe', () => {
    expect(managesLoginItem({ isPackaged: false, userData: DEFAULT, defaultUserData: DEFAULT })).toBe(false)
  })

  it('is false when started with another data folder, such as the packaged smoke test', () => {
    const userData = 'C:\\Users\\me\\AppData\\Local\\Temp\\cw-smoke-123'
    expect(managesLoginItem({ isPackaged: true, userData, defaultUserData: DEFAULT })).toBe(false)
  })
})
