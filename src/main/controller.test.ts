// The controller with the fake AWS account, a real in-memory store and a
// real settings folder: everything the IPC handlers do, minus Electron.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IpcEventChannel, IpcEvents, IpcResult } from '../shared/ipc'
import type { AppState } from '../shared/types'
import type { ClientFactory } from '../core/aws/clients'
import { openDb } from '../core/store/db'
import { migrate } from '../core/store/migrations'
import { createRepo, type Repo } from '../core/store/repo'
import { createController, type Controller } from './controller'
import { createFakeClientFactory, FAKE_ACCOUNT_ID } from './fakeAws'
import type { Toast } from './notifications'
import { loadSettings, saveSettings } from './settings'

let dir: string
let repo: Repo
let events: { channel: IpcEventChannel; payload: unknown }[]
let toasts: Toast[][]
let tooltips: string[]
let loginItem: boolean[]
let controller: Controller
let brokenProfiles: Set<string>
let opened: string[]

const expired = () => Object.assign(new Error('The SSO session associated with this profile has expired.'), { name: 'TokenProviderError' })

/** A client factory whose every call fails like an expired SSO session. */
function brokenFactory(profile: string): ClientFactory {
  return {
    profile,
    get: () =>
      ({
        send: async () => {
          throw expired()
        },
        destroy() {}
      }) as never,
    destroy() {}
  }
}

function build(profiles = ['demo', 'other']) {
  controller = createController({
    userDataDir: dir,
    repo,
    listProfiles: async () => profiles,
    createClients: (profile) => (brokenProfiles.has(profile) ? brokenFactory(profile) : createFakeClientFactory('demo')),
    emit: <C extends IpcEventChannel>(channel: C, payload: IpcEvents[C]) => void events.push({ channel, payload }),
    notify: (batch) => void toasts.push(batch),
    setTooltip: (text) => void tooltips.push(text),
    setLoginItem: (enabled) => void loginItem.push(enabled),
    openExternal: async (url) => void opened.push(url),
    log: () => {}
  })
  return controller
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-controller-'))
  const db = openDb(':memory:')
  migrate(db)
  repo = createRepo(db)
  events = []
  toasts = []
  tooltips = []
  loginItem = []
  brokenProfiles = new Set()
  opened = []
})

afterEach(() => {
  controller?.stop()
  rmSync(dir, { recursive: true, force: true })
})

function value<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`)
  return result.value
}

const states = () => events.filter((e) => e.channel === 'state:changed').map((e) => e.payload as AppState)

/** Waits until a state:changed event matches. */
async function until(predicate: (state: AppState) => boolean, ms = 5000): Promise<AppState> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const found = states().find(predicate)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('state never matched')
}
const scanned = () => until((state) => state.lastScan !== null && !state.scanInProgress)

describe('before a profile is chosen', () => {
  it('reports an empty state', async () => {
    const handlers = build().handlers
    expect(value(await handlers['app:getState'](undefined))).toEqual({
      identity: null,
      settings: { profile: null, scanIntervalMinutes: 15, notificationsEnabled: true, startAtLogin: false, rules: {} },
      lastScan: null,
      scanInProgress: false,
      problem: null
    })
    expect(value(await handlers['scan:getLatest'](undefined))).toBeNull()
  })

  it('lists profile names', async () => {
    expect(value(await build().handlers['profiles:list'](undefined))).toEqual(['demo', 'other'])
  })

  it('refuses to scan', async () => {
    expect(await build().handlers['scan:run'](undefined)).toEqual({
      ok: false,
      error: { code: 'not-found', message: 'Choose an AWS profile first.' }
    })
  })

  it('asks for a profile in the tray tooltip', () => {
    build().start()
    expect(tooltips.at(-1)).toBe('Cloud Watchdog: choose an AWS profile')
  })
})

describe('choosing a profile', () => {
  it('signs in, saves the choice, and starts scanning', async () => {
    const handlers = build().handlers
    expect(value(await handlers['profiles:select']({ profile: 'demo' }))).toEqual({
      accountId: FAKE_ACCOUNT_ID,
      arn: `arn:aws:iam::${FAKE_ACCOUNT_ID}:user/demo`,
      profile: 'demo'
    })
    expect(loadSettings(dir).settings.profile).toBe('demo')

    const state = await scanned()
    expect(state.identity?.accountId).toBe(FAKE_ACCOUNT_ID)
    expect(state.lastScan).toMatchObject({ resourceCount: 7, errorCount: 0 })
    expect(state.problem).toBeNull()
  })

  it('refuses a profile that is not configured on this machine', async () => {
    expect(await build().handlers['profiles:select']({ profile: 'nope' })).toEqual({
      ok: false,
      error: { code: 'not-found', message: 'There is no AWS profile called "nope" on this computer.' }
    })
  })

  it('explains an expired sign-in with the command that fixes it, and keeps the old choice', async () => {
    brokenProfiles.add('other')
    const handlers = build().handlers
    value(await handlers['profiles:select']({ profile: 'demo' }))

    const result = await handlers['profiles:select']({ profile: 'other' })
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'auth-expired',
        message:
          'The sign-in for profile "other" has expired or does not work. If it uses AWS SSO, sign in again with: aws sso login --profile other'
      }
    })
    expect(loadSettings(dir).settings.profile).toBe('demo')
  })
})

describe('scanning', () => {
  it('returns the id of the scan it starts, and sends progress', async () => {
    const handlers = build().handlers
    value(await handlers['profiles:select']({ profile: 'demo' }))
    await scanned()

    const { scanId } = value(await handlers['scan:run'](undefined))
    expect(scanId).toEqual(expect.any(String))
    await until((state) => state.lastScan?.scanId === scanId)
    const progress = events.filter((e) => e.channel === 'scan:progress').map((e) => e.payload as IpcEvents['scan:progress'])
    expect(progress.filter((p) => p.scanId === scanId).at(-1)).toMatchObject({ done: 14, total: 14 })
  })

  it('gives the full latest result', async () => {
    const handlers = build().handlers
    value(await handlers['profiles:select']({ profile: 'demo' }))
    await scanned()
    const latest = value(await handlers['scan:getLatest'](undefined))
    expect(latest?.resources).toHaveLength(7)
    expect(latest?.flags.length).toBeGreaterThan(0)
  })

  it('notifies new flags once, grouped, and shows the burn rate in the tooltip', async () => {
    const handlers = build().handlers
    value(await handlers['profiles:select']({ profile: 'demo' }))
    const first = await scanned()

    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toEqual([expect.objectContaining({ title: '8 new warnings in your AWS account', urgent: true })])
    expect(tooltips.at(-1)).toContain('$0.66/h')

    value(await handlers['scan:run'](undefined))
    await until((state) => state.lastScan !== null && state.lastScan.scanId !== first.lastScan!.scanId)
    expect(toasts).toHaveLength(1)
  })

  it('does not notify when notifications are off', async () => {
    saveSettings(dir, { profile: null, scanIntervalMinutes: 15, notificationsEnabled: false, startAtLogin: false, rules: {} })
    const handlers = build().handlers
    value(await handlers['profiles:select']({ profile: 'demo' }))
    await scanned()
    expect(toasts).toEqual([])
  })

  it('scans on start with the saved profile', async () => {
    saveSettings(dir, { profile: 'demo', scanIntervalMinutes: 15, notificationsEnabled: true, startAtLogin: false, rules: {} })
    build().start()
    const state = await scanned()
    expect(state.identity?.profile).toBe('demo')
  })

  it('reports a sign-in that expires later as a problem, with the fix', async () => {
    saveSettings(dir, { profile: 'demo', scanIntervalMinutes: 15, notificationsEnabled: true, startAtLogin: false, rules: {} })
    brokenProfiles.add('demo')
    build().start()
    const state = await until((s) => s.problem !== null)
    expect(state.problem).toEqual({
      code: 'auth-expired',
      message:
        'The sign-in for profile "demo" has expired or does not work. If it uses AWS SSO, sign in again with: aws sso login --profile demo'
    })
    expect(tooltips.at(-1)).toBe('Cloud Watchdog: sign-in expired')
  })
})

describe('dismissing a flag', () => {
  it('hides it until it resolves, and counts it out of the open flags', async () => {
    const handlers = build().handlers
    value(await handlers['profiles:select']({ profile: 'demo' }))
    const before = await scanned()
    const latest = value(await handlers['scan:getLatest'](undefined))!
    const flag = latest.flags[0]!

    expect(value(await handlers['flags:dismiss']({ flagId: flag.id }))).toBeNull()
    const after = value(await handlers['app:getState'](undefined))
    expect(after.lastScan!.openFlagCount).toBe(before.lastScan!.openFlagCount - 1)
    expect(repo.listFlags(FAKE_ACCOUNT_ID).find((f) => f.id === flag.id)?.dismissedUntil).toBe('9999-12-31T23:59:59.999Z')
  })

  it('hides it for a number of hours', async () => {
    const handlers = build().handlers
    value(await handlers['profiles:select']({ profile: 'demo' }))
    await scanned()
    const flag = value(await handlers['scan:getLatest'](undefined))!.flags[0]!
    const before = Date.now()
    value(await handlers['flags:dismiss']({ flagId: flag.id, hours: 2 }))
    const until = Date.parse(repo.listFlags(FAKE_ACCOUNT_ID).find((f) => f.id === flag.id)!.dismissedUntil!)
    expect(until - before).toBeGreaterThanOrEqual(2 * 3_600_000 - 1000)
    expect(until - before).toBeLessThanOrEqual(2 * 3_600_000 + 1000)
  })

  it('refuses a flag it does not have', async () => {
    const handlers = build().handlers
    value(await handlers['profiles:select']({ profile: 'demo' }))
    await scanned()
    expect(await handlers['flags:dismiss']({ flagId: 'nope' })).toEqual({
      ok: false,
      error: { code: 'not-found', message: 'That warning no longer exists.' }
    })
  })
})

describe('settings', () => {
  it('saves a change and returns the new settings', async () => {
    const handlers = build().handlers
    expect(value(await handlers['settings:update']({ scanIntervalMinutes: 30 })).scanIntervalMinutes).toBe(30)
    expect(loadSettings(dir).settings.scanIntervalMinutes).toBe(30)
    expect(states().at(-1)?.settings.scanIntervalMinutes).toBe(30)
  })

  it('switches start at login on and off', async () => {
    const handlers = build().handlers
    value(await handlers['settings:update']({ startAtLogin: true }))
    value(await handlers['settings:update']({ startAtLogin: false }))
    expect(loginItem).toEqual([true, false])
  })

  it('applies the saved start-at-login setting on start', () => {
    saveSettings(dir, { profile: null, scanIntervalMinutes: 15, notificationsEnabled: true, startAtLogin: true, rules: {} })
    build().start()
    expect(loginItem).toEqual([true])
  })

  it('does not change the profile: that goes through profiles:select, which checks the sign-in', async () => {
    const handlers = build().handlers
    expect(await handlers['settings:update']({ profile: 'other' })).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: 'Choose a profile with profiles:select.' }
    })
  })
})

describe('manual steps and the console', () => {
  const NAT = `${FAKE_ACCOUNT_ID}:nat-gateway:eu-west-1:nat-0demo000000000001`

  it('builds the console link and CLI command for a resource in the latest scan, with the profile', async () => {
    const handlers = build().handlers
    value(await handlers['profiles:select']({ profile: 'demo' }))
    await scanned()
    expect(value(await handlers['resource:manualSteps']({ resourceKey: NAT }))).toMatchObject({
      consoleUrl: 'https://eu-west-1.console.aws.amazon.com/vpcconsole/home?region=eu-west-1#NatGatewayDetails:natGatewayId=nat-0demo000000000001',
      cliCommand: 'aws ec2 delete-nat-gateway --nat-gateway-id nat-0demo000000000001 --region eu-west-1 --profile demo'
    })
  })

  it('opens the console page of the resource in the browser', async () => {
    const handlers = build().handlers
    value(await handlers['profiles:select']({ profile: 'demo' }))
    await scanned()
    expect(value(await handlers['resource:openConsole']({ resourceKey: NAT }))).toBeNull()
    expect(opened).toEqual([
      'https://eu-west-1.console.aws.amazon.com/vpcconsole/home?region=eu-west-1#NatGatewayDetails:natGatewayId=nat-0demo000000000001'
    ])
  })

  it.each(['resource:manualSteps', 'resource:openConsole'] as const)('%s refuses a key that is not in the latest scan', async (channel) => {
    const handlers = build().handlers
    value(await handlers['profiles:select']({ profile: 'demo' }))
    await scanned()
    expect(await handlers[channel]({ resourceKey: `${FAKE_ACCOUNT_ID}:nat-gateway:eu-west-1:nat-unknown` })).toEqual({
      ok: false,
      error: { code: 'not-found', message: 'That resource is not in the latest scan.' }
    })
    expect(opened).toEqual([])
  })
})

describe('not built yet', () => {
  it.each(['actions:preview', 'actions:execute'] as const)('%s refuses', async (channel) => {
    const handlers = build().handlers as Record<string, (input: unknown) => Promise<IpcResult<unknown>>>
    expect((await handlers[channel]!({})).ok).toBe(false)
  })
})
