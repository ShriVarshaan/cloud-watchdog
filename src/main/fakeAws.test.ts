// The fake account, run through the real scan engine and pipeline. This is
// what the end-to-end tests see, so it must produce a complete, believable scan.

import { beforeEach, describe, expect, it } from 'vitest'
import { createPlanReader } from '../core/freetier/planState'
import { createPricingEngine } from '../core/pricing/engine'
import { createPriceLookup } from '../core/pricing/priceListClient'
import { createIdleDetector } from '../core/rules/idle'
import { createScanEngine } from '../core/scan/engine'
import { previousResourcesFrom } from '../core/scan/persist'
import { completeScan } from '../core/scan/pipeline'
import { ALL_SCANNERS } from '../core/scanners'
import { openDb } from '../core/store/db'
import { migrate } from '../core/store/migrations'
import { createRepo, type Repo } from '../core/store/repo'
import { createFakeClientFactory, FAKE_ACCOUNT_ID, fakeScenarioFrom, type FakeScenario } from './fakeAws'

let repo: Repo
beforeEach(() => {
  const db = openDb(':memory:')
  migrate(db)
  repo = createRepo(db)
})

async function scan(scenario: FakeScenario) {
  const clients = createFakeClientFactory(scenario)
  const engine = createScanEngine({ clients, scanners: ALL_SCANNERS, loadPrevious: previousResourcesFrom(repo) })
  const signal = new AbortController().signal
  return completeScan(
    await engine.run(),
    {
      pricing: createPricingEngine({ lookup: createPriceLookup(clients), cache: repo }),
      plans: createPlanReader({ clients, repo }),
      idle: createIdleDetector({ clients, cache: repo }),
      repo,
      rules: {},
      now: () => new Date()
    },
    signal
  )
}

describe('fake AWS, demo scenario', () => {
  it('scans cleanly: no errors, the demo resources, all priced', async () => {
    const { result } = await scan('demo')

    expect(result.errors).toEqual([])
    expect(result.identity.accountId).toBe(FAKE_ACCOUNT_ID)
    expect(result.resources.map((r) => [r.kind, r.id, r.state])).toEqual([
      ['ebs-volume', 'vol-0demo0000000root1', 'in-use'],
      ['ebs-volume', 'vol-0demo00000spare1', 'available'],
      ['ec2-instance', 'i-0demo0000000old01', 'stopped'],
      ['ec2-instance', 'i-0demo0000000web01', 'running'],
      ['ec2-instance', 'i-0demo00000train01', 'running'],
      ['elastic-ip', 'eipalloc-0demo00000001', 'unassociated'],
      ['nat-gateway', 'nat-0demo000000000001', 'available']
    ])
    expect(result.burn.unknownCount).toBe(0)
    // t3.micro 0.0114 + its public address 0.005 + g4dn.xlarge 0.587 + idle IP 0.005 + NAT 0.048
    expect(result.burn.exactUsdPerHour).toBe(0.6564)
    // the two volumes: (8 x 0.088 + 20 x 0.11) / 730
    expect(result.burn.estimateUsdPerHour).toBe(0.00397808)
  })

  it('reads a free plan with credits, so everything is covered', async () => {
    const { result } = await scan('demo')
    expect(result.plan).toMatchObject({ planType: 'FREE', status: 'ACTIVE', remainingCreditsUsd: 87.5 })
    expect(result.resources.every((r) => r.coverage === 'covered')).toBe(true)
    expect(result.runway?.days).toBeGreaterThan(5)
  })

  it('raises the flags a demo should show', async () => {
    const { result, raised } = await scan('demo')
    expect(result.flags.map((f) => f.ruleId).sort()).toEqual([
      'gpu-instance',
      'idle-cpu',
      'long-running',
      // $87.50 at about $0.66 an hour lasts about 5 days
      'low-runway',
      'nat-gateway',
      'stopped-storage',
      'unassociated-ip',
      'unattached-volume'
    ])
    expect(raised).toHaveLength(8)
  })
})

describe('fake AWS, free tier denied', () => {
  it('scans resources but reports the plan as unavailable', async () => {
    const { result } = await scan('freetier-denied')
    expect(result.plan).toBeNull()
    expect(result.errors).toEqual([
      { scanner: 'freetier', region: null, code: 'access-denied', message: 'User is not authorized to perform: freetier:GetAccountPlanState' }
    ])
    expect(result.resources.every((r) => r.coverage === 'unknown')).toBe(true)
  })
})

describe('fakeScenarioFrom', () => {
  it.each([
    [undefined, null],
    ['', null],
    ['1', 'demo'],
    ['true', 'demo'],
    ['demo', 'demo'],
    ['freetier-denied', 'freetier-denied'],
    ['something-else', null]
  ])('%s -> %s', (value, scenario) => {
    expect(fakeScenarioFrom(value)).toBe(scenario)
  })
})

describe('fakeConfirmFrom', () => {
  it('answers confirmations for the end-to-end tests only when told to', async () => {
    const { fakeConfirmFrom } = await import('./fakeAws')
    expect(fakeConfirmFrom('yes')).toBe(true)
    expect(fakeConfirmFrom('no')).toBe(false)
    expect(fakeConfirmFrom(undefined)).toBeNull()
    expect(fakeConfirmFrom('')).toBeNull()
    expect(fakeConfirmFrom('true')).toBeNull()
  })
})
