// The guard around the only two calls that change anything in AWS. The driver
// here is a stand-in that records what it was asked to do; the real ones are
// tested in stopEc2.test.ts and stopRds.test.ts. The store is real.

import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IpcResult } from '../../shared/ipc'
import type { ActionPreview, Resource } from '../../shared/types'
import { createClientFactory, type ClientFactory } from '../aws/clients'
import { openDb } from '../store/db'
import { migrate } from '../store/migrations'
import { createRepo, type Repo } from '../store/repo'
import { createActionGuard, type ActionDriver, type ActionGuard, type Confirmation, type Facts } from './guard'

const ACCOUNT = '111122223333'
const KEY = `${ACCOUNT}:ec2-instance:eu-west-1:i-1`
const START = Date.parse('2026-11-11T10:00:00.000Z')

const instance: Resource = { key: KEY, kind: 'ec2-instance', region: 'eu-west-1', id: 'i-1', name: 'web', state: 'running', attrs: {} }

const sts = mockClient(STSClient)

let repo: Repo
let clients: ClientFactory
let enabled: boolean
let nowMs: number
/** What AWS says about the instance right now. null = it no longer exists. */
let live: Facts | null
let observeError: Error | null
let permissionBlocker: string | null
let stopError: Error | null
let calls: string[]
let confirmations: Confirmation[]
let answer: boolean
let duringConfirm: () => void
let guard: ActionGuard

const driver: ActionDriver = {
  action: 'stop-ec2',
  kind: 'ec2-instance',
  async observe(_clients, region, id) {
    calls.push(`observe ${region} ${id}`)
    if (observeError) throw observeError
    return live
  },
  blockers: (facts) => (facts.asg ? ['It belongs to an Auto Scaling group.'] : facts.state === 'running' ? [] : [`It is ${facts.state}, not running.`]),
  consequences: () => ['Its disks keep billing.'],
  async checkPermission() {
    calls.push('checkPermission')
    return permissionBlocker
  },
  async stop(_clients, region, id) {
    calls.push(`stop ${region} ${id}`)
    if (stopError) throw stopError
  },
  done: 'AWS is stopping the instance.'
}

function newClients(): ClientFactory {
  return createClientFactory({ profile: 'hackathon', credentials: async () => ({ accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'fake' }) })
}

beforeEach(() => {
  const db = openDb(':memory:')
  migrate(db)
  repo = createRepo(db)
  clients = newClients()
  sts.on(GetCallerIdentityCommand).resolves({ Account: ACCOUNT, Arn: `arn:aws:iam::${ACCOUNT}:user/watchdog` })
  enabled = true
  nowMs = START
  live = { state: 'running', asg: null }
  observeError = null
  permissionBlocker = null
  stopError = null
  calls = []
  confirmations = []
  answer = true
  duringConfirm = () => {}
  guard = createActionGuard({ drivers: [driver], enabled: () => enabled, log: repo, now: () => new Date(nowMs) })
})

afterEach(() => sts.reset())

function value<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`)
  return result.value
}

const confirm = async (confirmation: Confirmation) => {
  confirmations.push(confirmation)
  duringConfirm()
  return answer
}

async function previewed(): Promise<ActionPreview & { token: string }> {
  const preview = value(await guard.preview(clients, instance, 'stop-ec2'))
  if (!preview.token) throw new Error(`expected a token, got blockers: ${preview.blockers.join(' ')}`)
  calls = []
  return preview as ActionPreview & { token: string }
}

const execute = (token: string, signal = new AbortController().signal) => guard.execute(token, { clients, confirm, signal, accountId: ACCOUNT })

const stops = () => calls.filter((call) => call.startsWith('stop'))
const audit = () => repo.listActionLog(ACCOUNT).map(({ resourceKey, action, preState, result, error }) => ({ resourceKey, action, preState, result, error }))

describe('preview', () => {
  it('refuses while stopping is switched off, without asking AWS anything', async () => {
    enabled = false
    expect(await guard.preview(clients, instance, 'stop-ec2')).toEqual({
      ok: false,
      error: { code: 'refused', message: 'Stopping resources is switched off. Turn it on in Settings first.' }
    })
    expect(calls).toEqual([])
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(0)
  })

  it('reports the live state and the consequences, with a token good for 60 seconds', async () => {
    const preview = value(await guard.preview(clients, instance, 'stop-ec2'))
    expect(preview).toEqual({
      resourceKey: KEY,
      action: 'stop-ec2',
      liveState: 'running',
      consequences: ['Its disks keep billing.'],
      blockers: [],
      token: expect.any(String),
      expiresAt: '2026-11-11T10:01:00.000Z'
    })
    expect(calls).toEqual(['observe eu-west-1 i-1', 'checkPermission'])
  })

  it('gives no token when something blocks the stop, and does not go on to check permission', async () => {
    live = { state: 'running', asg: 'web-asg' }
    expect(value(await guard.preview(clients, instance, 'stop-ec2'))).toMatchObject({
      blockers: ['It belongs to an Auto Scaling group.'],
      consequences: ['Its disks keep billing.'],
      token: null,
      expiresAt: null
    })
    expect(calls).toEqual(['observe eu-west-1 i-1'])
  })

  it('judges the state AWS reports now, not the state of the last scan', async () => {
    live = { state: 'stopping', asg: null }
    expect(value(await guard.preview(clients, instance, 'stop-ec2'))).toMatchObject({
      liveState: 'stopping',
      blockers: ['It is stopping, not running.'],
      token: null
    })
  })

  it('gives no token when the profile is not allowed to stop it', async () => {
    permissionBlocker = 'This profile is not allowed to stop instances.'
    expect(value(await guard.preview(clients, instance, 'stop-ec2'))).toMatchObject({
      blockers: ['This profile is not allowed to stop instances.'],
      token: null
    })
  })

  it('refuses an action that does not fit the kind of resource', async () => {
    const volume: Resource = { ...instance, key: `${ACCOUNT}:ebs-volume:eu-west-1:vol-1`, kind: 'ebs-volume', id: 'vol-1' }
    expect(await guard.preview(clients, volume, 'stop-ec2')).toMatchObject({ ok: false, error: { code: 'refused' } })
    expect(calls).toEqual([])
  })

  it('refuses when the profile now signs in to a different account than the resource is in', async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: '999999999999', Arn: 'arn:aws:iam::999999999999:user/other' })
    const result = await guard.preview(clients, instance, 'stop-ec2')
    expect(result).toMatchObject({ ok: false, error: { code: 'refused' } })
    expect(!result.ok && result.error.message).toContain('999999999999')
    expect(calls).toEqual([])
  })

  it('says so when AWS no longer lists the resource', async () => {
    live = null
    expect(await guard.preview(clients, instance, 'stop-ec2')).toMatchObject({ ok: false, error: { code: 'not-found' } })
  })

  it('passes on why AWS refused to describe it', async () => {
    observeError = Object.assign(new Error('You are not authorized to perform this operation.'), { name: 'UnauthorizedOperation' })
    expect(await guard.preview(clients, instance, 'stop-ec2')).toEqual({
      ok: false,
      error: { code: 'access-denied', message: 'You are not authorized to perform this operation.' }
    })
  })

  it('makes a different, long token every time', async () => {
    const first = await previewed()
    const second = await previewed()
    expect(first.token).not.toBe(second.token)
    expect(first.token.length).toBeGreaterThanOrEqual(32)
  })
})

describe('execute', () => {
  it('asks for confirmation, checks again, stops the resource once and records it', async () => {
    const { token } = await previewed()
    expect(await execute(token)).toEqual({
      ok: true,
      value: { resourceKey: KEY, action: 'stop-ec2', message: 'AWS is stopping the instance.' }
    })
    expect(confirmations).toEqual([
      {
        action: 'stop-ec2',
        accountId: ACCOUNT,
        profile: 'hackathon',
        region: 'eu-west-1',
        id: 'i-1',
        name: 'web',
        consequences: ['Its disks keep billing.']
      }
    ])
    expect(calls).toEqual(['observe eu-west-1 i-1', 'stop eu-west-1 i-1'])
    expect(audit()).toEqual([{ resourceKey: KEY, action: 'stop-ec2', preState: 'running', result: 'stopped', error: null }])
  })

  it('signs in again right before stopping, to be sure of the account', async () => {
    const { token } = await previewed()
    sts.resetHistory()
    await execute(token)
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(1)
  })

  it('refuses a token it never issued', async () => {
    await previewed()
    expect(await execute('x'.repeat(43))).toMatchObject({ ok: false, error: { code: 'refused' } })
    expect(confirmations).toEqual([])
    expect(calls).toEqual([])
    expect(audit()).toMatchObject([{ resourceKey: '', action: 'unknown', result: 'refused' }])
  })

  it('accepts a token just before 60 seconds have passed', async () => {
    const { token } = await previewed()
    nowMs = START + 59_999
    expect((await execute(token)).ok).toBe(true)
  })

  it('refuses a token after 60 seconds, without asking or stopping', async () => {
    const { token } = await previewed()
    nowMs = START + 60_000
    const result = await execute(token)
    expect(result).toMatchObject({ ok: false, error: { code: 'refused' } })
    expect(!result.ok && result.error.message).toContain('expired')
    expect(confirmations).toEqual([])
    expect(calls).toEqual([])
    expect(audit()).toMatchObject([{ resourceKey: KEY, preState: 'running', result: 'refused' }])
  })

  it('refuses a token the second time: one confirmation stops at most one thing once', async () => {
    const { token } = await previewed()
    await execute(token)
    const again = await execute(token)
    expect(again).toMatchObject({ ok: false, error: { code: 'refused' } })
    expect(!again.ok && again.error.message).toContain('already used')
    expect(stops()).toHaveLength(1)
    expect(audit().map((row) => row.result)).toEqual(['stopped', 'refused'])
  })

  it('does not stop anything when the user cancels, and the token is spent', async () => {
    const { token } = await previewed()
    answer = false
    expect(await execute(token)).toEqual({ ok: false, error: { code: 'cancelled', message: 'Cancelled. Nothing was changed.' } })
    answer = true
    expect(await execute(token)).toMatchObject({ ok: false, error: { code: 'refused' } })
    expect(calls).toEqual([])
    expect(audit().map((row) => row.result)).toEqual(['cancelled', 'refused'])
  })

  it('refuses when stopping was switched off after the preview', async () => {
    const { token } = await previewed()
    enabled = false
    expect(await execute(token)).toMatchObject({ ok: false, error: { code: 'refused' } })
    expect(confirmations).toEqual([])
    expect(calls).toEqual([])
    expect(audit()).toMatchObject([{ resourceKey: KEY, result: 'refused' }])
  })

  it('refuses when the state changed between the preview and the stop, naming both states', async () => {
    const { token } = await previewed()
    live = { state: 'stopping', asg: null }
    const result = await execute(token)
    expect(result).toMatchObject({ ok: false, error: { code: 'refused' } })
    expect(!result.ok && result.error.message).toMatch(/running.*stopping/)
    expect(stops()).toEqual([])
    expect(audit()).toMatchObject([{ preState: 'running', result: 'refused' }])
  })

  it('refuses when anything else it judged changed, such as joining an Auto Scaling group', async () => {
    const { token } = await previewed()
    live = { state: 'running', asg: 'web-asg' }
    expect(await execute(token)).toMatchObject({ ok: false, error: { code: 'refused' } })
    expect(stops()).toEqual([])
  })

  it('checks again after the confirmation, however long the dialog stayed open', async () => {
    const { token } = await previewed()
    duringConfirm = () => {
      live = { state: 'stopped', asg: null }
    }
    expect(await execute(token)).toMatchObject({ ok: false, error: { code: 'refused' } })
    expect(stops()).toEqual([])
  })

  it('refuses when the resource is gone', async () => {
    const { token } = await previewed()
    live = null
    expect(await execute(token)).toMatchObject({ ok: false, error: { code: 'not-found' } })
    expect(stops()).toEqual([])
    expect(audit()).toMatchObject([{ result: 'refused' }])
  })

  it('refuses when the profile signs in to a different account than at the preview', async () => {
    const { token } = await previewed()
    sts.on(GetCallerIdentityCommand).resolves({ Account: '999999999999', Arn: 'arn:aws:iam::999999999999:user/other' })
    const result = await execute(token)
    expect(result).toMatchObject({ ok: false, error: { code: 'refused' } })
    expect(!result.ok && result.error.message).toContain('999999999999')
    expect(calls).toEqual([])
    expect(audit()).toMatchObject([{ resourceKey: KEY, result: 'refused' }])
  })

  it('refuses a token from another session (the profile was changed since)', async () => {
    const { token } = await previewed()
    const result = await guard.execute(token, { clients: newClients(), confirm, signal: new AbortController().signal, accountId: ACCOUNT })
    expect(result).toMatchObject({ ok: false, error: { code: 'refused' } })
    expect(confirmations).toEqual([])
    expect(calls).toEqual([])
  })

  it('refuses when the session ended while the confirmation was open', async () => {
    const { token } = await previewed()
    const session = new AbortController()
    duringConfirm = () => session.abort()
    expect(await execute(token, session.signal)).toMatchObject({ ok: false, error: { code: 'refused' } })
    expect(calls).toEqual([])
    expect(audit()).toMatchObject([{ result: 'refused' }])
  })

  it('reports cleanly when AWS denies the stop, and records the failure', async () => {
    const { token } = await previewed()
    stopError = Object.assign(new Error('You are not authorized to perform this operation.'), { name: 'UnauthorizedOperation' })
    expect(await execute(token)).toEqual({
      ok: false,
      error: { code: 'access-denied', message: 'AWS did not stop it: You are not authorized to perform this operation.' }
    })
    expect(audit()).toEqual([
      { resourceKey: KEY, action: 'stop-ec2', preState: 'running', result: 'failed', error: 'You are not authorized to perform this operation.' }
    ])
  })

  it('does not stop anything it cannot record first', async () => {
    const { token } = await previewed()
    const broken = createActionGuard({
      drivers: [driver],
      enabled: () => true,
      log: {
        addActionLog: () => {
          throw new Error('disk full')
        },
        finishActionLog: () => {}
      },
      now: () => new Date(nowMs)
    })
    const fresh = value(await broken.preview(clients, instance, 'stop-ec2')).token!
    calls = []
    expect(await broken.execute(fresh, { clients, confirm, signal: new AbortController().signal, accountId: ACCOUNT })).toMatchObject({
      ok: false,
      error: { code: 'refused' }
    })
    expect(stops()).toEqual([])
    // The first guard's token is untouched by the second guard.
    expect((await execute(token)).ok).toBe(true)
  })

  it('still reports the stop when only the note of its outcome could not be written', async () => {
    let rows = 0
    const flaky = createActionGuard({
      drivers: [driver],
      enabled: () => true,
      log: {
        addActionLog: () => ++rows,
        finishActionLog: () => {
          throw new Error('disk full')
        }
      },
      now: () => new Date(nowMs)
    })
    const token = value(await flaky.preview(clients, instance, 'stop-ec2')).token!
    expect((await flaky.execute(token, { clients, confirm, signal: new AbortController().signal, accountId: ACCOUNT })).ok).toBe(true)
    expect(rows).toBe(1)
  })
})
