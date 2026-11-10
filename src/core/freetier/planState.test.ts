import { FreeTierClient, GetAccountPlanStateCommand, GetFreeTierUsageCommand } from '@aws-sdk/client-freetier'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  alwaysFreeRows,
  freePlanActive,
  paidPlanNoCredits,
  paidPlanWithCredits,
  twelveMonthRow
} from '../../../tests/fixtures/freeTier'
import { createClientFactory, type ClientFactory } from '../aws/clients'
import { openDb } from '../store/db'
import { migrate } from '../store/migrations'
import { createRepo, type Repo } from '../store/repo'
import { createPlanReader } from './planState'

const ACCOUNT = '111122223333'
const HOUR_MS = 60 * 60 * 1000

const freeTier = mockClient(FreeTierClient)
afterEach(() => freeTier.reset())

const real = createClientFactory({
  profile: 'hackathon',
  credentials: async () => ({ accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'fake' })
})
let regionsUsed: string[]
const clients: ClientFactory = {
  profile: real.profile,
  get: (service, region) => {
    regionsUsed.push(region)
    return real.get(service, region)
  },
  destroy: () => real.destroy()
}

function denied(action: string): Error {
  return Object.assign(new Error(`User is not authorized to perform: ${action}`), { name: 'AccessDeniedException' })
}

let repo: Repo
let now: Date
const signal = new AbortController().signal
const reader = () => createPlanReader({ clients, repo, now: () => now })
const planCalls = () => freeTier.commandCalls(GetAccountPlanStateCommand).length
const usageCalls = () => freeTier.commandCalls(GetFreeTierUsageCommand).length

beforeEach(() => {
  const db = openDb(':memory:')
  migrate(db)
  repo = createRepo(db)
  now = new Date('2026-11-10T12:00:00.000Z')
  regionsUsed = []
})

describe('reading the account plan', () => {
  it('maps a free-plan account with credits, asking the us-east-1 endpoint', async () => {
    freeTier.on(GetAccountPlanStateCommand).resolves(freePlanActive)

    expect(await reader().read(ACCOUNT, signal)).toEqual({
      plan: {
        planType: 'FREE',
        status: 'ACTIVE',
        remainingCreditsUsd: 150.5,
        expiresAt: '2027-02-18T12:00:00.000Z',
        fetchedAt: '2026-11-10T12:00:00.000Z'
      },
      usage: null,
      errors: []
    })
    expect(regionsUsed).toEqual(['us-east-1'])
  })

  it('has no credit figure and no end date when AWS leaves them out', async () => {
    freeTier.on(GetAccountPlanStateCommand).resolves(paidPlanNoCredits)
    freeTier.on(GetFreeTierUsageCommand).resolves({ freeTierUsages: [] })

    expect((await reader().read(ACCOUNT, signal)).plan).toMatchObject({
      planType: 'PAID',
      status: 'ACTIVE',
      remainingCreditsUsd: null,
      expiresAt: null
    })
  })

  it('saves a snapshot of the plan each time it is fetched', async () => {
    freeTier.on(GetAccountPlanStateCommand).resolves(freePlanActive)
    await reader().read(ACCOUNT, signal)
    expect(repo.getLatestPlanSnapshot(ACCOUNT)).toMatchObject({ remainingCreditsUsd: 150.5, fetchedAt: '2026-11-10T12:00:00.000Z' })
  })

  it('reports a denied plan call as a freetier error, with no plan and no usage call', async () => {
    freeTier.on(GetAccountPlanStateCommand).rejects(denied('freetier:GetAccountPlanState'))

    expect(await reader().read(ACCOUNT, signal)).toEqual({
      plan: null,
      usage: null,
      errors: [
        {
          scanner: 'freetier',
          region: null,
          code: 'access-denied',
          message: 'User is not authorized to perform: freetier:GetAccountPlanState'
        }
      ]
    })
    expect(usageCalls()).toBe(0)
    expect(repo.getLatestPlanSnapshot(ACCOUNT)).toBeNull()
  })

  it.each([
    ['plan type', { ...freePlanActive, accountPlanType: 'ENTERPRISE' }],
    ['plan status', { ...freePlanActive, accountPlanStatus: 'SUSPENDED' }],
    ['plan type (missing)', { accountId: ACCOUNT }]
  ])('treats an answer with an unexpected %s as "plan unknown", not as a guess', async (_what, response) => {
    freeTier.on(GetAccountPlanStateCommand).resolves(response as never)
    const report = await reader().read(ACCOUNT, signal)
    expect(report.plan).toBeNull()
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]).toMatchObject({ scanner: 'freetier', region: null, code: 'unknown' })
  })

  it('ignores a credit amount that is not in USD', async () => {
    freeTier.on(GetAccountPlanStateCommand).resolves({
      ...freePlanActive,
      accountPlanRemainingCredits: { amount: 150.5, unit: 'EUR' as never }
    })
    expect((await reader().read(ACCOUNT, signal)).plan?.remainingCreditsUsd).toBeNull()
  })

  it('rejects, instead of reporting an error, when the scan was cancelled', async () => {
    const controller = new AbortController()
    freeTier.on(GetAccountPlanStateCommand).callsFake(() => {
      controller.abort()
      throw Object.assign(new Error('Request aborted'), { name: 'AbortError' })
    })
    await expect(reader().read(ACCOUNT, controller.signal)).rejects.toThrow('Request aborted')
  })
})

describe('reading free tier usage', () => {
  it.each([
    ['a free-plan account', freePlanActive],
    ['a paid account that still has credits', paidPlanWithCredits]
  ])('is not asked for %s: credits decide coverage there', async (_name, planResponse) => {
    freeTier.on(GetAccountPlanStateCommand).resolves(planResponse)
    const report = await reader().read(ACCOUNT, signal)
    expect(report.usage).toBeNull()
    expect(usageCalls()).toBe(0)
  })

  it('is read, across every page, for a paid account without credits', async () => {
    const ec2Hours = twelveMonthRow('Global-BoxUsage:freetier.micro', 240, 720, 750)
    freeTier.on(GetAccountPlanStateCommand).resolves(paidPlanNoCredits)
    freeTier
      .on(GetFreeTierUsageCommand)
      .resolves({ freeTierUsages: alwaysFreeRows.slice(0, 2), nextToken: 'page-2' })
      .on(GetFreeTierUsageCommand, { nextToken: 'page-2' })
      .resolves({ freeTierUsages: [alwaysFreeRows[2]!, ec2Hours] })

    const report = await reader().read(ACCOUNT, signal)
    expect(report.errors).toEqual([])
    expect(report.usage).toHaveLength(4)
    expect(report.usage![3]).toEqual({
      service: 'Amazon Elastic Compute Cloud',
      usageType: 'Global-BoxUsage:freetier.micro',
      operation: '',
      region: 'global',
      actualUsage: 240,
      forecastedUsage: 720,
      limit: 750,
      unit: 'Hrs',
      freeTierType: '12 Months Free'
    })
    expect(usageCalls()).toBe(2)
  })

  it('counts zero credits as no credits', async () => {
    freeTier.on(GetAccountPlanStateCommand).resolves({ ...paidPlanWithCredits, accountPlanRemainingCredits: { amount: 0, unit: 'USD' } })
    freeTier.on(GetFreeTierUsageCommand).resolves({ freeTierUsages: [] })
    expect((await reader().read(ACCOUNT, signal)).usage).toEqual([])
  })

  it('keeps the plan when only the usage call is denied', async () => {
    freeTier.on(GetAccountPlanStateCommand).resolves(paidPlanNoCredits)
    freeTier.on(GetFreeTierUsageCommand).rejects(denied('freetier:GetFreeTierUsage'))

    const report = await reader().read(ACCOUNT, signal)
    expect(report.plan?.planType).toBe('PAID')
    expect(report.usage).toBeNull()
    expect(report.errors).toEqual([
      { scanner: 'freetier', region: null, code: 'access-denied', message: 'User is not authorized to perform: freetier:GetFreeTierUsage' }
    ])
  })

  it('drops a row without a usage type or a limit: it cannot be matched to anything', async () => {
    freeTier.on(GetAccountPlanStateCommand).resolves(paidPlanNoCredits)
    freeTier.on(GetFreeTierUsageCommand).resolves({
      freeTierUsages: [{ service: 'AWS Glue', region: 'global', actualUsageAmount: 1 }, alwaysFreeRows[0]!]
    })
    expect((await reader().read(ACCOUNT, signal)).usage).toHaveLength(1)
  })
})

describe('fetching at most once an hour', () => {
  it('answers a second read within the hour from memory', async () => {
    freeTier.on(GetAccountPlanStateCommand).resolves(freePlanActive)
    const plans = reader()
    const first = await plans.read(ACCOUNT, signal)

    now = new Date(now.getTime() + HOUR_MS - 1000)
    expect(await plans.read(ACCOUNT, signal)).toEqual(first)
    expect(planCalls()).toBe(1)
  })

  it('fetches again after an hour', async () => {
    freeTier.on(GetAccountPlanStateCommand).resolves(freePlanActive)
    const plans = reader()
    await plans.read(ACCOUNT, signal)

    now = new Date(now.getTime() + HOUR_MS)
    const second = await plans.read(ACCOUNT, signal)
    expect(planCalls()).toBe(2)
    expect(second.plan?.fetchedAt).toBe('2026-11-10T13:00:00.000Z')
  })

  it('does not reuse the answer for another account', async () => {
    freeTier.on(GetAccountPlanStateCommand).resolves(freePlanActive)
    const plans = reader()
    await plans.read(ACCOUNT, signal)
    await plans.read('999900001111', signal)
    expect(planCalls()).toBe(2)
  })

  it('tries again on the next read after a failed plan call', async () => {
    freeTier.on(GetAccountPlanStateCommand).rejectsOnce(denied('freetier:GetAccountPlanState')).resolves(freePlanActive)
    const plans = reader()
    expect((await plans.read(ACCOUNT, signal)).plan).toBeNull()
    expect((await plans.read(ACCOUNT, signal)).plan?.planType).toBe('FREE')
  })

  it('keeps reporting a denied usage call while the answer is reused', async () => {
    freeTier.on(GetAccountPlanStateCommand).resolves(paidPlanNoCredits)
    freeTier.on(GetFreeTierUsageCommand).rejects(denied('freetier:GetFreeTierUsage'))
    const plans = reader()
    await plans.read(ACCOUNT, signal)

    const again = await plans.read(ACCOUNT, signal)
    expect(again.errors).toHaveLength(1)
    expect(usageCalls()).toBe(1)
  })
})
