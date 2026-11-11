import { beforeEach, describe, expect, it } from 'vitest'
import { recordedProducts } from '../../../tests/fixtures/pricing'
import type { AttrValue, PlanState, ResourceKind, RuleSetting, ScanError } from '../../shared/types'
import type { PlanReader, PlanReport } from '../freetier/planState'
import { createPricingEngine } from '../pricing/engine'
import { selectUnitPrice, type PriceLookup } from '../pricing/priceListClient'
import type { CpuReport, IdleDetector } from '../rules/idle'
import { openDb, type Db } from '../store/db'
import { migrate } from '../store/migrations'
import { createRepo, type Repo } from '../store/repo'
import { ScanAbortedError, type RawScan, type ScannedResource } from './engine'
import { completeScan, loadLatestResult, summarize, type PipelineDeps } from './pipeline'

const ACCOUNT = '111122223333'
const NOW = new Date('2026-11-10T12:20:00.000Z')
const signal = new AbortController().signal

function make(kind: ResourceKind, id: string, state: string, attrs: Record<string, AttrValue>, stale = false): ScannedResource {
  return {
    key: `${ACCOUNT}:${kind}:eu-west-1:${id}`,
    kind,
    region: 'eu-west-1',
    id,
    state,
    createdAt: '2026-11-01T00:00:00.000Z',
    attrs,
    stale
  }
}
const nat = make('nat-gateway', 'nat-1', 'available', { connectivityType: 'public', availabilityMode: 'zonal' })
const stoppedInstance = make('ec2-instance', 'i-1', 'stopped', {
  instanceType: 't3.micro',
  usageOperation: 'RunInstances',
  tenancy: 'default',
  lifecycle: 'on-demand',
  publicIp: null
})
const runningInstance = make('ec2-instance', 'i-2', 'running', {
  instanceType: 't3.micro',
  usageOperation: 'RunInstances',
  tenancy: 'default',
  lifecycle: 'on-demand',
  publicIp: null
})

function raw(resources: ScannedResource[], errors: ScanError[] = [], scanId = 'scan-1', startedAt = '2026-11-10T12:19:00.000Z'): RawScan {
  return {
    scanId,
    startedAt,
    finishedAt: '2026-11-10T12:19:30.000Z',
    identity: { accountId: ACCOUNT, arn: `arn:aws:iam::${ACCOUNT}:user/watchdog`, profile: 'hackathon' },
    resources,
    errors
  }
}

const freePlan: PlanState = {
  planType: 'FREE',
  status: 'ACTIVE',
  remainingCreditsUsd: 115.2,
  // 200 days after NOW
  expiresAt: '2027-05-29T12:20:00.000Z',
  fetchedAt: NOW.toISOString()
}

const recordedLookup: PriceLookup = async (query) => selectUnitPrice(recordedProducts(query.serviceCode, query.filters), query)

let db: Db
let repo: Repo
let planReport: PlanReport
let cpuReport: CpuReport
let idleCalls: number[]

beforeEach(() => {
  db = openDb(':memory:')
  migrate(db)
  repo = createRepo(db)
  planReport = { plan: freePlan, usage: null, errors: [] }
  cpuReport = { readings: new Map(), errors: [] }
  idleCalls = []
})

function deps(rules: Record<string, RuleSetting> = {}, lookup: PriceLookup = recordedLookup): PipelineDeps {
  const plans: PlanReader = {
    read: async (accountId) => {
      // The real reader saves a snapshot per fetch; so does this one.
      if (planReport.plan) repo.addPlanSnapshot(accountId, planReport.plan)
      return planReport
    }
  }
  const idle: IdleDetector = {
    read: async (_resources, windowHours) => {
      idleCalls.push(windowHours)
      return cpuReport
    }
  }
  return {
    pricing: createPricingEngine({ lookup, cache: repo, bundled: {}, now: () => NOW }),
    plans,
    idle,
    repo,
    rules,
    now: () => NOW
  }
}

describe('completeScan', () => {
  it('prices, covers, works out the runway and flags, all in one result', async () => {
    // In key order, as the engine returns them.
    const { result } = await completeScan(raw([stoppedInstance, nat]), deps(), signal)

    expect(result.resources.map((r) => [r.id, r.price.hourlyUsd, r.price.confidence, r.coverage])).toEqual([
      ['i-1', 0, 'exact', 'covered'],
      ['nat-1', 0.048, 'exact', 'covered']
    ])
    expect(result.burn).toEqual({ exactUsdPerHour: 0.048, estimateUsdPerHour: 0, unknownCount: 0 })
    expect(result.plan).toEqual(freePlan)
    // $115.20 / ($0.048 x 24) = 100 days, before the plan ends; NAT data processing is not in the rate.
    expect(result.runway).toEqual({ creditDays: 100, planDays: 200, days: 100, isUpperBound: true })
    expect(result.flags.map((f) => [f.ruleId, f.resourceKey]).sort()).toEqual([
      ['nat-gateway', nat.key],
      ['stopped-storage', stoppedInstance.key]
    ])
    expect(result.scanId).toBe('scan-1')
  })

  it('returns new flags as raised once, and not on the next scan', async () => {
    const first = await completeScan(raw([nat]), deps(), signal)
    expect(first.raised.map((f) => f.ruleId)).toEqual(['nat-gateway'])

    const second = await completeScan(raw([nat], [], 'scan-2', '2026-11-10T12:35:00.000Z'), deps(), signal)
    expect(second.raised).toEqual([])
    expect(second.result.flags.map((f) => f.id)).toEqual(first.result.flags.map((f) => f.id))
  })

  it('saves the scan and its flags', async () => {
    const { result } = await completeScan(raw([nat]), deps(), signal)
    expect(repo.getLatestScan(ACCOUNT)?.resources).toEqual(result.resources)
    expect(repo.listFlags(ACCOUNT)).toEqual(result.flags)
  })

  it('collects every error: scan, pricing, free tier and CloudWatch', async () => {
    const throttled: ScanError = { scanner: 'rds-instance', region: 'us-east-1', code: 'throttled', message: 'slow down' }
    const deniedPricing: PriceLookup = async () => {
      throw Object.assign(new Error('no pricing'), { name: 'AccessDeniedException' })
    }
    planReport = { plan: null, usage: null, errors: [{ scanner: 'freetier', region: null, code: 'access-denied', message: 'no plan' }] }
    cpuReport = { readings: new Map(), errors: [{ scanner: 'cloudwatch', region: 'eu-west-1', code: 'access-denied', message: 'no cpu' }] }

    const { result } = await completeScan(raw([nat, runningInstance], [throttled]), deps({}, deniedPricing), signal)
    expect(result.errors.map((e) => e.scanner)).toEqual(['rds-instance', 'pricing', 'freetier', 'cloudwatch'])
  })

  it('degrades without the plan: coverage unknown, no runway, no account flags', async () => {
    planReport = { plan: null, usage: null, errors: [{ scanner: 'freetier', region: null, code: 'access-denied', message: 'no' }] }
    const { result } = await completeScan(raw([nat]), deps(), signal)

    expect(result.plan).toBeNull()
    expect(result.runway).toBeNull()
    expect(result.resources[0]!.coverage).toBe('unknown')
    expect(result.flags.every((f) => f.resourceKey !== null)).toBe(true)
  })

  it('asks CloudWatch with the idle window from settings', async () => {
    await completeScan(raw([runningInstance]), deps({ 'idle-cpu': { enabled: true, params: { windowHours: 12 } } }), signal)
    expect(idleCalls).toEqual([12])
  })

  it('does not ask CloudWatch at all when the idle rule is off', async () => {
    await completeScan(raw([runningInstance]), deps({ 'idle-cpu': { enabled: false, params: {} } }), signal)
    expect(idleCalls).toEqual([])
  })

  it('raises an idle flag from the CPU readings', async () => {
    cpuReport = { readings: new Map([[runningInstance.key, { maxCpu: 0.7, datapoints: 6, windowEnd: '2026-11-10T12:00:00.000Z' }]]), errors: [] }
    const { result } = await completeScan(raw([runningInstance]), deps(), signal)
    expect(result.flags.map((f) => f.ruleId)).toContain('idle-cpu')
  })

  it('keeps the flags of a stale resource without resolving them', async () => {
    await completeScan(raw([nat]), deps(), signal)
    const { result, raised } = await completeScan(raw([{ ...nat, stale: true }], [], 'scan-2', '2026-11-10T12:35:00.000Z'), deps(), signal)
    expect(raised).toEqual([])
    expect(result.flags.map((f) => f.ruleId)).toEqual(['nat-gateway'])
  })

  it('removes scans older than 30 days', async () => {
    await completeScan(raw([nat], [], 'old', '2026-10-01T00:00:00.000Z'), deps(), signal)
    await completeScan(raw([nat], [], 'new'), deps(), signal)
    expect(db.all<{ id: string }>('SELECT id FROM scans').map((row) => row.id)).toEqual(['new'])
  })

  it('saves nothing when the scan is cancelled on the way', async () => {
    const controller = new AbortController()
    const cancelling = deps()
    cancelling.idle = {
      read: async () => {
        controller.abort()
        return cpuReport
      }
    }
    await expect(completeScan(raw([runningInstance]), cancelling, controller.signal)).rejects.toBeInstanceOf(ScanAbortedError)
    expect(repo.getLatestScan(ACCOUNT)).toBeNull()
    expect(repo.listFlags(ACCOUNT)).toEqual([])
  })

  it('warns when a database the app stopped 8 days ago is running again', async () => {
    const database = make('rds-instance', 'shop-db', 'available', { instanceClass: 'db.t3.micro', engine: 'postgres' })
    repo.addActionLog({
      at: '2026-11-02T12:00:00.000Z',
      accountId: ACCOUNT,
      resourceKey: database.key,
      action: 'stop-rds',
      preState: 'available',
      result: 'stopped',
      error: null
    })
    const { raised } = await completeScan(raw([database]), deps(), signal)
    expect(raised.filter((flag) => flag.ruleId === 'rds-restarted')).toMatchObject([{ resourceKey: database.key, severity: 'warn' }])
  })
})

describe('loadLatestResult', () => {
  it('rebuilds the last result from the store after a restart', async () => {
    const { result } = await completeScan(raw([stoppedInstance, nat]), deps(), signal)
    expect(loadLatestResult(repo, ACCOUNT, NOW)).toEqual(result)
  })

  it('returns null for an account that was never scanned', () => {
    expect(loadLatestResult(repo, ACCOUNT, NOW)).toBeNull()
  })

  it('has no plan or runway when no plan was ever read', async () => {
    planReport = { plan: null, usage: null, errors: [] }
    await completeScan(raw([nat]), deps(), signal)
    expect(loadLatestResult(repo, ACCOUNT, NOW)).toMatchObject({ plan: null, runway: null })
  })
})

describe('summarize', () => {
  it('counts resources, open flags not dismissed, and errors', async () => {
    const { result } = await completeScan(raw([nat, stoppedInstance], [{ scanner: 'regions', region: null, code: 'network', message: 'x' }]), deps(), signal)
    const dismissed = { ...result, flags: [{ ...result.flags[0]!, dismissedUntil: '2026-11-11T00:00:00.000Z' }, result.flags[1]!] }

    expect(summarize(dismissed, NOW)).toEqual({
      scanId: 'scan-1',
      finishedAt: '2026-11-10T12:19:30.000Z',
      burn: result.burn,
      plan: result.plan,
      runway: result.runway,
      resourceCount: 2,
      openFlagCount: 1,
      errorCount: 1
    })
  })
})
