import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'

// These run against the built app, so they prove the pieces that unit tests
// cannot: the bundled preload works under the sandbox, zod validation runs in
// the real main process, and SQLite opens inside Electron.

type Result = { ok: boolean; value?: unknown; error?: { code: string; message: string } }
type Bridge = Record<string, (input?: unknown) => Promise<Result>>

test.describe('IPC bridge', () => {
  test('exposes the contract methods and nothing from Electron', async ({ mainWindow }) => {
    const keys = await mainWindow.evaluate(() =>
      Object.keys((globalThis as unknown as { watchdog: object }).watchdog).sort()
    )
    expect(keys).toEqual(
      [
        'apiVersion',
        'dismissFlag',
        'executeAction',
        'getLatestScan',
        'getManualSteps',
        'getState',
        'listProfiles',
        'onScanProgress',
        'onStateChanged',
        'openConsole',
        'previewAction',
        'runScan',
        'selectProfile',
        'setActionsEnabled',
        'updateSettings'
      ].sort()
    )
  })

  test('getState round-trips through the main process', async ({ mainWindow }) => {
    const result = await mainWindow.evaluate(async () => {
      const watchdog = (globalThis as unknown as { watchdog: Bridge }).watchdog
      return watchdog['getState']!()
    })
    expect(result).toEqual({
      ok: true,
      value: {
        identity: null,
        settings: {
          profile: null,
          scanIntervalMinutes: 15,
          notificationsEnabled: true,
          startAtLogin: true,
          actionsEnabled: false,
          rules: {}
        },
        lastScan: null,
        scanInProgress: false,
        problem: null
      }
    })
  })

  test('the main process rejects malformed input', async ({ mainWindow }) => {
    const results = await mainWindow.evaluate(async () => {
      const watchdog = (globalThis as unknown as { watchdog: Bridge }).watchdog
      return Promise.all([
        watchdog['dismissFlag']!({ flagId: 5 }),
        watchdog['openConsole']!({ resourceKey: 'https://example.com/' }),
        watchdog['updateSettings']!({ actionsEnabled: true }),
        watchdog['previewAction']!({ resourceKey: '111122223333:ec2-instance:eu-west-1:i-0abc', action: 'terminate' })
      ])
    })
    for (const result of results) {
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    }
  })

  test('profile listing returns names only', async ({ mainWindow }) => {
    const result = await mainWindow.evaluate(async () => {
      const watchdog = (globalThis as unknown as { watchdog: Bridge }).watchdog
      return watchdog['listProfiles']!()
    })
    expect(result.ok).toBe(true)
    expect(Array.isArray(result.value)).toBe(true)
    for (const name of result.value as unknown[]) expect(typeof name).toBe('string')
  })
})

test.describe('local database', () => {
  test('is created in the user-data folder on start', async ({ app, mainWindow }) => {
    await mainWindow.waitForLoadState('load')
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    expect(userData).toContain('cloud-watchdog-e2e-')
    expect(existsSync(join(userData, 'watchdog.db'))).toBe(true)
  })
})

