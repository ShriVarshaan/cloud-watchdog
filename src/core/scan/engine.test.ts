import { DescribeRegionsCommand, EC2Client } from '@aws-sdk/client-ec2'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resourceKey, type Resource, type ResourceKind, type ScanProgress } from '../../shared/types'
import { createClientFactory } from '../aws/clients'
import { createScanEngine, ScanAbortedError, ScanFailedError, type ScanEngineOptions } from './engine'
import type { ScanContext, Scanner } from './scanner'

const ACCOUNT = '111122223333'
const sts = mockClient(STSClient)
const ec2 = mockClient(EC2Client)

function awsError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name })
}

function setRegions(...names: string[]) {
  ec2.on(DescribeRegionsCommand).resolves({
    Regions: names.map((RegionName) => ({ RegionName, OptInStatus: 'opt-in-not-required' }))
  })
}

beforeEach(() => {
  sts.on(GetCallerIdentityCommand).resolves({ Account: ACCOUNT, Arn: `arn:aws:iam::${ACCOUNT}:user/watchdog` })
  setRegions('eu-west-1', 'us-east-1')
})

afterEach(() => {
  sts.reset()
  ec2.reset()
})

const clients = createClientFactory({
  profile: 'hackathon',
  credentials: async () => ({ accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'fake' })
})

function resource(kind: ResourceKind, region: string, id: string, state = 'running'): Resource {
  return { key: resourceKey(ACCOUNT, kind, region, id), kind, region, id, state, attrs: {} }
}

type ScanFn = (ctx: ScanContext) => Promise<Resource[]>

/** A scanner whose behaviour the test supplies. It records every call it gets. */
function fakeScanner(kind: ResourceKind, service: Scanner['service'], scan: ScanFn) {
  const calls: ScanContext[] = []
  const scanner: Scanner = {
    kind,
    service,
    requiredActions: [],
    scan: (ctx) => {
      calls.push(ctx)
      return scan(ctx)
    }
  }
  return { scanner, calls }
}

/** One instance per region, named after the region. */
const oneInstancePerRegion: ScanFn = async (ctx) => [resource('ec2-instance', ctx.region, `i-${ctx.region}`)]

function engine(scanners: Scanner[], overrides: Partial<ScanEngineOptions> = {}) {
  return createScanEngine({ clients, scanners, loadPrevious: () => [], ...overrides })
}

/** Resolves when `signal` aborts, by rejecting like an SDK call does. */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(awsError('AbortError', 'Request aborted')), { once: true })
  })
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('scan engine: a clean scan', () => {
  it('runs every scanner in every enabled region and returns what they found', async () => {
    const instances = fakeScanner('ec2-instance', 'ec2', oneInstancePerRegion)
    const databases = fakeScanner('rds-instance', 'rds', async (ctx) =>
      ctx.region === 'us-east-1' ? [resource('rds-instance', 'us-east-1', 'db-1', 'available')] : []
    )

    const scan = await engine([instances.scanner, databases.scanner]).run()

    expect(scan.resources).toEqual([
      { ...resource('ec2-instance', 'eu-west-1', 'i-eu-west-1'), stale: false },
      { ...resource('ec2-instance', 'us-east-1', 'i-us-east-1'), stale: false },
      { ...resource('rds-instance', 'us-east-1', 'db-1', 'available'), stale: false }
    ])
    expect(scan.errors).toEqual([])
    expect(instances.calls.map((ctx) => ctx.region).sort()).toEqual(['eu-west-1', 'us-east-1'])
    expect(databases.calls.map((ctx) => ctx.region).sort()).toEqual(['eu-west-1', 'us-east-1'])
  })

  it('reports who the scan ran as and gives scanners that account id', async () => {
    const instances = fakeScanner('ec2-instance', 'ec2', oneInstancePerRegion)
    const scan = await engine([instances.scanner]).run()
    expect(scan.identity).toEqual({
      accountId: ACCOUNT,
      arn: `arn:aws:iam::${ACCOUNT}:user/watchdog`,
      profile: 'hackathon'
    })
    expect(instances.calls.every((ctx) => ctx.accountId === ACCOUNT && ctx.clients === clients)).toBe(true)
  })

  it('stamps the scan with a fresh id and its start and finish times', async () => {
    const times = [new Date('2026-11-10T09:00:00.000Z'), new Date('2026-11-10T09:00:07.000Z')]
    const scanEngine = engine([fakeScanner('ec2-instance', 'ec2', oneInstancePerRegion).scanner], {
      now: () => times.shift() ?? new Date('2026-11-10T10:00:00.000Z')
    })
    const first = await scanEngine.run()
    const second = await scanEngine.run()
    expect(first.startedAt).toBe('2026-11-10T09:00:00.000Z')
    expect(first.finishedAt).toBe('2026-11-10T09:00:07.000Z')
    expect(first.scanId).not.toBe('')
    expect(second.scanId).not.toBe(first.scanId)
  })

  it('reports progress from zero to the number of (scanner, region) tasks', async () => {
    const progress: ScanProgress[] = []
    const scan = await engine(
      [
        fakeScanner('ec2-instance', 'ec2', oneInstancePerRegion).scanner,
        fakeScanner('rds-instance', 'rds', async () => []).scanner
      ],
      { onProgress: (p) => progress.push(p) }
    ).run()
    expect(progress.map((p) => [p.done, p.total])).toEqual([
      [0, 4],
      [1, 4],
      [2, 4],
      [3, 4],
      [4, 4]
    ])
    expect(progress.every((p) => p.scanId === scan.scanId)).toBe(true)
  })

  it('counts a failed task as done in the progress', async () => {
    const progress: ScanProgress[] = []
    await engine([fakeScanner('ec2-instance', 'ec2', async () => Promise.reject(awsError('AccessDenied'))).scanner], {
      onProgress: (p) => progress.push(p)
    }).run()
    expect(progress.at(-1)).toMatchObject({ done: 2, total: 2 })
  })
})

describe('scan engine: partial failure', () => {
  it('keeps the results of other regions when one region is denied', async () => {
    const instances = fakeScanner('ec2-instance', 'ec2', async (ctx) => {
      if (ctx.region === 'eu-west-1') throw awsError('UnauthorizedOperation', 'You are not authorized')
      return oneInstancePerRegion(ctx)
    })
    const scan = await engine([instances.scanner]).run()
    expect(scan.resources.map((r) => r.id)).toEqual(['i-us-east-1'])
    expect(scan.errors).toEqual([
      { scanner: 'ec2-instance', region: 'eu-west-1', code: 'access-denied', message: 'You are not authorized' }
    ])
  })

  it('keeps the results of other scanners when one scanner is denied everywhere', async () => {
    const instances = fakeScanner('ec2-instance', 'ec2', oneInstancePerRegion)
    const databases = fakeScanner('rds-instance', 'rds', async () => Promise.reject(awsError('AccessDenied', 'no rds')))
    const scan = await engine([instances.scanner, databases.scanner]).run()
    expect(scan.resources.map((r) => r.id)).toEqual(['i-eu-west-1', 'i-us-east-1'])
    expect(scan.errors).toEqual([
      { scanner: 'rds-instance', region: 'eu-west-1', code: 'access-denied', message: 'no rds' },
      { scanner: 'rds-instance', region: 'us-east-1', code: 'access-denied', message: 'no rds' }
    ])
  })

  it('classifies throttling that outlasted the retries', async () => {
    const instances = fakeScanner('ec2-instance', 'ec2', async () =>
      Promise.reject(awsError('RequestLimitExceeded', 'Request limit exceeded.'))
    )
    const scan = await engine([instances.scanner]).run()
    expect(scan.errors.map((e) => e.code)).toEqual(['throttled', 'throttled'])
  })

  it('turns a scanner that throws synchronously into a scan error, not a failed scan', async () => {
    const broken = fakeScanner('ec2-instance', 'ec2', () => {
      throw new TypeError('cannot read properties of undefined')
    })
    const scan = await engine([broken.scanner]).run()
    expect(scan.errors.map((e) => [e.region, e.code])).toEqual([
      ['eu-west-1', 'unknown'],
      ['us-east-1', 'unknown']
    ])
  })

  it('gives up on a task that takes longer than the timeout, and cancels it', async () => {
    let hungSignal: AbortSignal | undefined
    const instances = fakeScanner('ec2-instance', 'ec2', (ctx) => {
      if (ctx.region !== 'eu-west-1') return oneInstancePerRegion(ctx)
      hungSignal = ctx.signal
      return new Promise<Resource[]>(() => {}) // never answers, ignores the signal
    })
    const scan = await engine([instances.scanner], { taskTimeoutMs: 20 }).run()
    expect(scan.resources.map((r) => r.id)).toEqual(['i-us-east-1'])
    expect(scan.errors).toEqual([
      { scanner: 'ec2-instance', region: 'eu-west-1', code: 'network', message: expect.stringMatching(/timed out/i) }
    ])
    expect(hungSignal?.aborted).toBe(true)
  })

  it('does not time out a task for the time it spent waiting for a slot', async () => {
    setRegions('ap-south-1', 'eu-west-1', 'us-east-1')
    const slow = fakeScanner('ec2-instance', 'ec2', async (ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return oneInstancePerRegion(ctx)
    })
    // One at a time: the last task waits about 60 ms, longer than the 50 ms timeout.
    const scan = await engine([slow.scanner], { taskTimeoutMs: 50, globalConcurrency: 1 }).run()
    expect(scan.errors).toEqual([])
    expect(scan.resources).toHaveLength(3)
  })
})

describe('scan engine: duplicates', () => {
  it('keeps one copy when a scanner returns the same resource twice', async () => {
    const twice = fakeScanner('ec2-instance', 'ec2', async (ctx) =>
      ctx.region === 'us-east-1'
        ? [resource('ec2-instance', 'us-east-1', 'i-1', 'pending'), resource('ec2-instance', 'us-east-1', 'i-1', 'running')]
        : []
    )
    const scan = await engine([twice.scanner]).run()
    expect(scan.resources).toEqual([{ ...resource('ec2-instance', 'us-east-1', 'i-1', 'running'), stale: false }])
  })
})

describe('scan engine: staleness', () => {
  const previous = [
    resource('ec2-instance', 'eu-west-1', 'i-old-ireland'),
    resource('ec2-instance', 'us-east-1', 'i-old-virginia'),
    resource('rds-instance', 'eu-west-1', 'db-old-ireland', 'available')
  ]

  it('carries resources of a failed (scanner, region) forward as stale instead of dropping them', async () => {
    const instances = fakeScanner('ec2-instance', 'ec2', async (ctx) => {
      if (ctx.region === 'eu-west-1') throw awsError('RequestLimitExceeded')
      return [] // us-east-1 was looked at: i-old-virginia is really gone
    })
    const databases = fakeScanner('rds-instance', 'rds', async () => [])
    const scan = await engine([instances.scanner, databases.scanner], { loadPrevious: () => previous }).run()

    expect(scan.resources).toEqual([{ ...resource('ec2-instance', 'eu-west-1', 'i-old-ireland'), stale: true }])
  })

  it('asks for the previous resources of the account the scan runs as', async () => {
    const asked: string[] = []
    await engine([fakeScanner('ec2-instance', 'ec2', oneInstancePerRegion).scanner], {
      loadPrevious: (accountId) => {
        asked.push(accountId)
        return []
      }
    }).run()
    expect(asked).toEqual([ACCOUNT])
  })

  it('never carries forward a resource that belongs to another account', async () => {
    const foreign: Resource = {
      ...resource('ec2-instance', 'eu-west-1', 'i-foreign'),
      key: resourceKey('999999999999', 'ec2-instance', 'eu-west-1', 'i-foreign')
    }
    const failing = fakeScanner('ec2-instance', 'ec2', async () => Promise.reject(awsError('AccessDenied')))
    const scan = await engine([failing.scanner], { loadPrevious: () => [foreign] }).run()
    expect(scan.resources).toEqual([])
  })

  it('keeps a resource stale across several failed scans', async () => {
    const failing = fakeScanner('ec2-instance', 'ec2', async () => Promise.reject(awsError('AccessDenied')))
    let known: Resource[] = [resource('ec2-instance', 'eu-west-1', 'i-old-ireland')]
    const scanEngine = engine([failing.scanner], { loadPrevious: () => known })

    const first = await scanEngine.run()
    known = first.resources
    const second = await scanEngine.run()

    expect(second.resources).toEqual([{ ...resource('ec2-instance', 'eu-west-1', 'i-old-ireland'), stale: true }])
  })

  it('marks a carried resource fresh again once its region can be scanned', async () => {
    let fail = true
    const instances = fakeScanner('ec2-instance', 'ec2', async (ctx) => {
      if (fail) throw awsError('RequestLimitExceeded')
      return ctx.region === 'eu-west-1' ? [resource('ec2-instance', 'eu-west-1', 'i-old-ireland', 'stopped')] : []
    })
    let known: Resource[] = [resource('ec2-instance', 'eu-west-1', 'i-old-ireland')]
    const scanEngine = engine([instances.scanner], { loadPrevious: () => known })

    known = (await scanEngine.run()).resources
    fail = false
    const recovered = await scanEngine.run()

    expect(recovered.resources).toEqual([
      { ...resource('ec2-instance', 'eu-west-1', 'i-old-ireland', 'stopped'), stale: false }
    ])
  })

  it('drops earlier resources in a region that is no longer enabled', async () => {
    setRegions('us-east-1')
    const scan = await engine([fakeScanner('ec2-instance', 'ec2', async () => []).scanner], {
      loadPrevious: () => previous
    }).run()
    expect(scan.resources).toEqual([])
  })

  it('carries everything forward as stale when the region list cannot be fetched', async () => {
    ec2.on(DescribeRegionsCommand).rejects(awsError('UnauthorizedOperation', 'not allowed to list regions'))
    const instances = fakeScanner('ec2-instance', 'ec2', oneInstancePerRegion)
    const scan = await engine([instances.scanner], { loadPrevious: () => previous }).run()

    expect(scan.errors).toEqual([
      { scanner: 'regions', region: null, code: 'access-denied', message: 'not allowed to list regions' }
    ])
    expect(scan.resources.map((r) => [r.id, r.stale])).toEqual([
      ['i-old-ireland', true],
      ['i-old-virginia', true],
      ['db-old-ireland', true]
    ])
    expect(instances.calls).toHaveLength(0)
  })
})

describe('scan engine: identity', () => {
  it('fails the whole scan, with a classified code, when the identity cannot be read', async () => {
    sts.on(GetCallerIdentityCommand).rejects(awsError('ExpiredToken', 'The security token is expired'))
    const instances = fakeScanner('ec2-instance', 'ec2', oneInstancePerRegion)
    const error = await engine([instances.scanner])
      .run()
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ScanFailedError)
    expect(error).toMatchObject({ code: 'auth-expired', message: 'The security token is expired' })
    expect(instances.calls).toHaveLength(0)
  })

  it('can scan again after a failed scan', async () => {
    sts.on(GetCallerIdentityCommand).rejectsOnce(awsError('ExpiredToken')).resolves({
      Account: ACCOUNT,
      Arn: `arn:aws:iam::${ACCOUNT}:user/watchdog`
    })
    const scanEngine = engine([fakeScanner('ec2-instance', 'ec2', oneInstancePerRegion).scanner])
    await expect(scanEngine.run()).rejects.toBeInstanceOf(ScanFailedError)
    expect(scanEngine.inProgress).toBe(false)
    expect((await scanEngine.run()).resources).toHaveLength(2)
  })
})

describe('scan engine: concurrency', () => {
  const REGIONS = ['ap-south-1', 'ap-southeast-1', 'eu-central-1', 'eu-west-1', 'us-east-1', 'us-west-2']

  /** Scanners that count how many of them are inside `scan` at the same time. */
  function instrumented() {
    let running = 0
    let peak = 0
    const runningByService = new Map<string, number>()
    const peakByService = new Map<string, number>()

    const make = (kind: ResourceKind, service: Scanner['service']) =>
      fakeScanner(kind, service, async () => {
        running++
        peak = Math.max(peak, running)
        const mine = (runningByService.get(service) ?? 0) + 1
        runningByService.set(service, mine)
        peakByService.set(service, Math.max(peakByService.get(service) ?? 0, mine))
        await tick()
        await tick()
        running--
        runningByService.set(service, (runningByService.get(service) ?? 1) - 1)
        return []
      }).scanner

    return {
      scanners: [
        make('ec2-instance', 'ec2'),
        make('ebs-volume', 'ec2'), // shares the ec2 bucket with ec2-instance
        make('rds-instance', 'rds'),
        make('load-balancer', 'elb'),
        make('sagemaker-endpoint', 'sagemaker')
      ],
      peak: () => peak,
      peakByService: () => Object.fromEntries(peakByService)
    }
  }

  it('never exceeds the global cap or the per-service cap, and does use them', async () => {
    setRegions(...REGIONS)
    const probe = instrumented()
    const scan = await engine(probe.scanners, { globalConcurrency: 5, perServiceConcurrency: 2 }).run()

    expect(scan.errors).toEqual([])
    expect(probe.peak()).toBe(5)
    const peaks = probe.peakByService()
    expect(Object.keys(peaks).sort()).toEqual(['ec2', 'elb', 'rds', 'sagemaker'])
    expect(Math.max(...Object.values(peaks))).toBe(2)
    expect(peaks.ec2).toBe(2) // 12 ec2 tasks were waiting: the cap, not the workload, held them at 2
  })

  it('defaults to 8 tasks at once and 3 per service', async () => {
    setRegions(...REGIONS)
    const probe = instrumented()
    await engine(probe.scanners).run()
    expect(probe.peak()).toBe(8)
    const peaks = probe.peakByService()
    expect(Math.max(...Object.values(peaks))).toBe(3)
    expect(peaks.ec2).toBe(3)
  })
})

describe('scan engine: single flight', () => {
  it('knows the id of the scan in progress from the moment it starts, and forgets it after', async () => {
    const scanEngine = engine([fakeScanner('ec2-instance', 'ec2', oneInstancePerRegion).scanner])
    expect(scanEngine.currentScanId).toBeNull()

    const running = scanEngine.run()
    const id = scanEngine.currentScanId
    expect(id).toEqual(expect.any(String))

    expect((await running).scanId).toBe(id)
    expect(scanEngine.currentScanId).toBeNull()
  })

  it('shares one scan between two run() calls made while it is in progress', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const instances = fakeScanner('ec2-instance', 'ec2', async (ctx) => {
      await gate
      return oneInstancePerRegion(ctx)
    })
    const scanEngine = engine([instances.scanner])

    const first = scanEngine.run()
    const second = scanEngine.run()
    expect(scanEngine.inProgress).toBe(true)
    release()
    const [a, b] = await Promise.all([first, second])

    expect(b).toBe(a)
    expect(instances.calls).toHaveLength(2) // once per region, not twice
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(1)
    expect(scanEngine.inProgress).toBe(false)
  })

  it('starts a new scan once the previous one has finished', async () => {
    const instances = fakeScanner('ec2-instance', 'ec2', oneInstancePerRegion)
    const scanEngine = engine([instances.scanner])
    const first = await scanEngine.run()
    const second = await scanEngine.run()
    expect(second).not.toBe(first)
    expect(instances.calls).toHaveLength(4)
  })
})

describe('scan engine: abort', () => {
  it('cancels running tasks, never starts waiting ones, and rejects the scan', async () => {
    setRegions('ap-south-1', 'eu-west-1', 'us-east-1')
    const signals: AbortSignal[] = []
    const instances = fakeScanner('ec2-instance', 'ec2', (ctx) => {
      signals.push(ctx.signal)
      return untilAborted(ctx.signal)
    })
    const scanEngine = engine([instances.scanner], { perServiceConcurrency: 2 })

    const run = scanEngine.run().catch((e: unknown) => e)
    await expect.poll(() => instances.calls.length).toBe(2)
    scanEngine.abort()

    expect(await run).toBeInstanceOf(ScanAbortedError)
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true])
    await tick()
    expect(instances.calls).toHaveLength(2) // the third region never started
    expect(scanEngine.inProgress).toBe(false)
  })

  it('rejects as aborted even when tasks ignore the signal and finish normally', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const instances = fakeScanner('ec2-instance', 'ec2', async (ctx) => {
      await gate
      return oneInstancePerRegion(ctx)
    })
    const scanEngine = engine([instances.scanner])
    const run = scanEngine.run().catch((e: unknown) => e)
    await expect.poll(() => instances.calls.length).toBe(2)
    scanEngine.abort()
    release()
    expect(await run).toBeInstanceOf(ScanAbortedError)
  })

  it('aborts while the identity is still being fetched', async () => {
    sts.on(GetCallerIdentityCommand).callsFake(
      (_input, getClient) =>
        new Promise((_, reject) => {
          void getClient
          setTimeout(() => reject(awsError('AbortError')), 5)
        })
    )
    const instances = fakeScanner('ec2-instance', 'ec2', oneInstancePerRegion)
    const scanEngine = engine([instances.scanner])
    const run = scanEngine.run().catch((e: unknown) => e)
    scanEngine.abort()
    expect(await run).toBeInstanceOf(ScanAbortedError)
    expect(instances.calls).toHaveLength(0)
  })

  it('does nothing when no scan is running, and the next scan works', async () => {
    const scanEngine = engine([fakeScanner('ec2-instance', 'ec2', oneInstancePerRegion).scanner])
    scanEngine.abort()
    expect((await scanEngine.run()).resources).toHaveLength(2)
  })

  it('can scan again after an aborted scan', async () => {
    let hang = true
    const instances = fakeScanner('ec2-instance', 'ec2', (ctx) =>
      hang ? untilAborted(ctx.signal) : oneInstancePerRegion(ctx)
    )
    const scanEngine = engine([instances.scanner])
    const run = scanEngine.run().catch((e: unknown) => e)
    await expect.poll(() => instances.calls.length).toBe(2)
    scanEngine.abort()
    await run

    hang = false
    const next = await scanEngine.run()
    expect(next.resources.map((r) => r.id)).toEqual(['i-eu-west-1', 'i-us-east-1'])
    expect(next.errors).toEqual([])
  })
})
