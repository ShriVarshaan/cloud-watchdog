// The engine and the SQLite store together: what one scan saves is what the
// next scan carries forward.

import { DescribeRegionsCommand, EC2Client } from '@aws-sdk/client-ec2'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resourceKey, type Resource } from '../../shared/types'
import { createClientFactory } from '../aws/clients'
import { openDb, type Db } from '../store/db'
import { migrate } from '../store/migrations'
import { createRepo, type Repo } from '../store/repo'
import { createScanEngine, type RawScan } from './engine'
import { previousResourcesFrom, toUnpricedScanResult } from './persist'
import type { Scanner } from './scanner'

const ACCOUNT = '111122223333'
const sts = mockClient(STSClient)
const ec2 = mockClient(EC2Client)
const clients = createClientFactory({
  profile: 'hackathon',
  credentials: async () => ({ accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'fake' })
})

let db: Db
let repo: Repo

beforeEach(() => {
  sts.on(GetCallerIdentityCommand).resolves({ Account: ACCOUNT, Arn: `arn:aws:iam::${ACCOUNT}:user/watchdog` })
  ec2.on(DescribeRegionsCommand).resolves({ Regions: [{ RegionName: 'eu-west-1' }, { RegionName: 'us-east-1' }] })
  db = openDb(':memory:')
  migrate(db)
  repo = createRepo(db)
})

afterEach(() => {
  sts.reset()
  ec2.reset()
  db.close()
})

function instance(region: string, id: string): Resource {
  return {
    key: resourceKey(ACCOUNT, 'ec2-instance', region, id),
    kind: 'ec2-instance',
    region,
    id,
    name: `name-of-${id}`,
    state: 'running',
    createdAt: '2026-11-08T14:30:00.000Z',
    attrs: { instanceType: 't3.micro', publicIp: null }
  }
}

describe('toUnpricedScanResult', () => {
  const raw: RawScan = {
    scanId: 'scan-1',
    startedAt: '2026-11-10T09:00:00.000Z',
    finishedAt: '2026-11-10T09:00:05.000Z',
    identity: { accountId: ACCOUNT, arn: `arn:aws:iam::${ACCOUNT}:user/watchdog`, profile: 'hackathon' },
    resources: [
      { ...instance('eu-west-1', 'i-1'), stale: false },
      { ...instance('us-east-1', 'i-2'), stale: true }
    ],
    errors: [{ scanner: 'ec2-instance', region: 'us-east-1', code: 'throttled', message: 'slow down' }]
  }

  it('gives every resource an unknown price and unknown coverage, never a number', () => {
    const result = toUnpricedScanResult(raw)
    expect(result.resources).toEqual([
      {
        ...instance('eu-west-1', 'i-1'),
        stale: false,
        price: { hourlyUsd: null, confidence: 'unknown', source: 'none', excluded: [] },
        coverage: 'unknown'
      },
      {
        ...instance('us-east-1', 'i-2'),
        stale: true,
        price: { hourlyUsd: null, confidence: 'unknown', source: 'none', excluded: [] },
        coverage: 'unknown'
      }
    ])
  })

  it('reports a burn rate of zero known dollars with every resource unpriced', () => {
    expect(toUnpricedScanResult(raw).burn).toEqual({ exactUsdPerHour: 0, estimateUsdPerHour: 0, unknownCount: 2 })
  })

  it('keeps the scan id, times, identity and errors, and has no flags, plan or runway yet', () => {
    expect(toUnpricedScanResult(raw)).toMatchObject({
      scanId: 'scan-1',
      startedAt: '2026-11-10T09:00:00.000Z',
      finishedAt: '2026-11-10T09:00:05.000Z',
      identity: raw.identity,
      errors: raw.errors,
      flags: [],
      plan: null,
      runway: null
    })
  })
})

describe('scan, save, scan again', () => {
  it('a region that fails in the second scan keeps its saved resources, marked stale', async () => {
    let irelandFails = false
    let virginiaDeleted = false
    const scanner: Scanner = {
      kind: 'ec2-instance',
      service: 'ec2',
      requiredActions: [],
      async scan(ctx) {
        if (ctx.region === 'eu-west-1') {
          if (irelandFails) throw Object.assign(new Error('Request limit exceeded.'), { name: 'RequestLimitExceeded' })
          return [instance('eu-west-1', 'i-ireland')]
        }
        return virginiaDeleted ? [] : [instance('us-east-1', 'i-virginia')]
      }
    }
    const times = ['2026-11-10T09:00:00.000Z', '2026-11-10T09:00:05.000Z', '2026-11-10T09:15:00.000Z', '2026-11-10T09:15:05.000Z']
    const engine = createScanEngine({
      clients,
      scanners: [scanner],
      loadPrevious: previousResourcesFrom(repo),
      now: () => new Date(times.shift() ?? '2026-11-10T10:00:00.000Z')
    })

    repo.saveScan(toUnpricedScanResult(await engine.run()))
    expect(repo.getLatestScan(ACCOUNT)?.resources.map((r) => [r.id, r.stale])).toEqual([
      ['i-ireland', false],
      ['i-virginia', false]
    ])

    irelandFails = true
    virginiaDeleted = true
    repo.saveScan(toUnpricedScanResult(await engine.run()))

    const latest = repo.getLatestScan(ACCOUNT)
    // Ireland: not looked at, kept as it was. Virginia: looked at, really gone.
    expect(latest?.resources).toEqual([
      {
        ...instance('eu-west-1', 'i-ireland'),
        stale: true,
        price: { hourlyUsd: null, confidence: 'unknown', source: 'none', excluded: [] },
        coverage: 'unknown'
      }
    ])
    expect(latest?.errors).toEqual([
      { scanner: 'ec2-instance', region: 'eu-west-1', code: 'throttled', message: 'Request limit exceeded.' }
    ])
    // Last seen stays at the first scan: the second scan did not see it.
    expect(repo.getResourceTimes(instance('eu-west-1', 'i-ireland').key)?.lastSeenAt).toBe('2026-11-10T09:00:00.000Z')

    irelandFails = false
    repo.saveScan(toUnpricedScanResult(await engine.run()))
    expect(repo.getLatestScan(ACCOUNT)?.resources.map((r) => [r.id, r.stale])).toEqual([['i-ireland', false]])
  })

  it('the first scan of an account has nothing to carry forward', () => {
    expect(previousResourcesFrom(repo)(ACCOUNT)).toEqual([])
  })
})
