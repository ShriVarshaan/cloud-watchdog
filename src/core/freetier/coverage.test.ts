import { describe, expect, it } from 'vitest'
import type { AttrValue, PlanState, Resource, ResourceKind } from '../../shared/types'
import { decideCoverage, planNotice } from './coverage'
import type { FreeTierUsageRow } from './planState'

function plan(over: Partial<PlanState> = {}): PlanState {
  return {
    planType: 'PAID',
    status: 'ACTIVE',
    remainingCreditsUsd: null,
    expiresAt: null,
    fetchedAt: '2026-11-10T12:00:00.000Z',
    ...over
  }
}

function make(kind: ResourceKind, state: string, attrs: Record<string, AttrValue>, region = 'eu-west-1'): Resource {
  return { key: `111122223333:${kind}:${region}:x`, kind, region, id: 'x', state, attrs }
}

const microInstance = (over: Record<string, AttrValue> = {}, region = 'eu-west-1') =>
  make('ec2-instance', 'running', { instanceType: 't3.micro', tenancy: 'default', lifecycle: 'on-demand', ...over }, region)

function row(usageType: string, actualUsage: number | null, forecastedUsage: number | null, limit: number, region = 'global'): FreeTierUsageRow {
  return { service: '', usageType, operation: '', region, actualUsage, forecastedUsage, limit, unit: 'Hrs', freeTierType: '12 Months Free' }
}
const ec2Hours = (actual: number | null, forecast: number | null, region = 'global') =>
  row('Global-BoxUsage:freetier.micro', actual, forecast, 750, region)

describe('the coverage decision table', () => {
  it('plan call denied or failed: unknown', () => {
    expect(decideCoverage(microInstance(), null, null)).toEqual({
      coverage: 'unknown',
      message: 'Plan details unavailable for this account. Showing resources only.'
    })
  })

  it('free plan, active, credits left: covered, and the account closes when they run out', () => {
    const free = plan({ planType: 'FREE', remainingCreditsUsd: 150.5 })
    expect(decideCoverage(microInstance({ instanceType: 'g4dn.xlarge' }), free, null)).toEqual({
      coverage: 'covered',
      message: 'Paid from credits. The account closes when they run out.'
    })
  })

  it('paid plan with credits left: covered, and charged once they run out', () => {
    expect(decideCoverage(microInstance(), plan({ remainingCreditsUsd: 42 }), null)).toEqual({
      coverage: 'covered',
      message: 'Paid from credits. You are charged once they run out.'
    })
  })

  it('paid, no credits, matching free allowance with forecast within the limit: covered', () => {
    expect(decideCoverage(microInstance(), plan(), [ec2Hours(240, 720)])).toEqual({
      coverage: 'covered',
      message: 'Within the monthly free allowance.'
    })
  })

  it.each([
    ['actual use is over the limit', ec2Hours(751, 751)],
    ['the forecast is over the limit', ec2Hours(400, 1200)]
  ])('paid, no credits, allowance exists but %s: not covered', (_why, usage) => {
    expect(decideCoverage(microInstance(), plan(), [usage])).toEqual({ coverage: 'not-covered', message: 'Free allowance used up.' })
  })

  it('paid, no credits, no matching allowance: not covered', () => {
    expect(decideCoverage(microInstance(), plan(), [])).toEqual({ coverage: 'not-covered', message: null })
  })

  it('expired plan: not covered, whatever credits it still reports', () => {
    const expired = plan({ planType: 'FREE', status: 'EXPIRED', remainingCreditsUsd: 20 })
    expect(decideCoverage(microInstance(), expired, null)).toEqual({ coverage: 'not-covered', message: null })
  })

  it('usage call denied but plan call worked, paid without credits: unknown', () => {
    expect(decideCoverage(microInstance(), plan(), null)).toEqual({ coverage: 'unknown', message: null })
  })
})

describe('credits', () => {
  it('counts zero credits on a paid plan as no credits', () => {
    expect(decideCoverage(microInstance(), plan({ remainingCreditsUsd: 0 }), []).coverage).toBe('not-covered')
  })

  it('free plan with the credits used up: not covered', () => {
    const free = plan({ planType: 'FREE', remainingCreditsUsd: 0 })
    expect(decideCoverage(microInstance(), free, null)).toEqual({ coverage: 'not-covered', message: 'Credits used up.' })
  })

  it('free plan with no credit figure from AWS: unknown, not assumed covered', () => {
    const free = plan({ planType: 'FREE', remainingCreditsUsd: null })
    expect(decideCoverage(microInstance(), free, null).coverage).toBe('unknown')
  })

  it('a free plan that has not started but has credits is covered like an active one', () => {
    const free = plan({ planType: 'FREE', status: 'NOT_STARTED', remainingCreditsUsd: 100 })
    expect(decideCoverage(microInstance(), free, null).coverage).toBe('covered')
  })
})

describe('matching a resource to a free allowance (paid plan, no credits)', () => {
  const covered = (resource: Resource, usage: FreeTierUsageRow[]) => decideCoverage(resource, plan(), usage).coverage

  it.each<[string, Resource, string]>([
    ['a t2.micro instance', microInstance({ instanceType: 't2.micro' }), 'Global-BoxUsage:freetier.micro'],
    ['a gp3 volume', make('ebs-volume', 'in-use', { volumeType: 'gp3', sizeGb: 30 }), 'Global-EBS:VolumeUsage'],
    [
      'a single-AZ MySQL db.t3.micro',
      make('rds-instance', 'available', { instanceClass: 'db.t3.micro', engine: 'mysql', multiAz: false, clusterId: null }),
      'Global-InstanceUsage:db.t1.micro'
    ],
    ['an Application Load Balancer', make('load-balancer', 'active', { type: 'application' }), 'Global-LoadBalancerUsage'],
    ['an Elastic IP in use', make('elastic-ip', 'associated', { publicIpv4Pool: 'amazon' }), 'Global-PublicIPv4:InUseAddress']
  ])('%s is covered by its allowance', (_name, resource, usageType) => {
    expect(covered(resource, [row(usageType, 10, 30, 750)])).toBe('covered')
    // ...and by nothing else
    expect(covered(resource, [row('Catalog-Request', 10, 30, 1000000)])).toBe('not-covered')
  })

  it.each<[string, Resource]>([
    ['an instance type outside the free tier', microInstance({ instanceType: 'm5.large' })],
    ['a spot instance', microInstance({ lifecycle: 'spot' })],
    ['a dedicated instance', microInstance({ tenancy: 'dedicated' })],
    ['an io1 volume', make('ebs-volume', 'in-use', { volumeType: 'io1', sizeGb: 30 })],
    [
      'a Multi-AZ database',
      make('rds-instance', 'available', { instanceClass: 'db.t3.micro', engine: 'mysql', multiAz: true, clusterId: null })
    ],
    [
      'a large database class',
      make('rds-instance', 'available', { instanceClass: 'db.m5.large', engine: 'mysql', multiAz: false, clusterId: null })
    ],
    ['a Network Load Balancer', make('load-balancer', 'active', { type: 'network' })],
    ['an idle Elastic IP', make('elastic-ip', 'unassociated', { publicIpv4Pool: 'amazon' })],
    ['a NAT gateway', make('nat-gateway', 'available', { availabilityMode: 'zonal' })],
    ['a SageMaker endpoint', make('sagemaker-endpoint', 'in-service', { variants: '[]' })]
  ])('%s is never covered, even when an allowance of its kind has room', (_name, resource) => {
    const everyAllowance = [
      'Global-BoxUsage:freetier.micro',
      'Global-EBS:VolumeUsage',
      'Global-InstanceUsage:db.t1.micro',
      'Global-LoadBalancerUsage',
      'Global-PublicIPv4:InUseAddress'
    ].map((usageType) => row(usageType, 0, 0, 750))
    expect(covered(resource, everyAllowance)).toBe('not-covered')
  })

  it('accepts an allowance for the resource\'s own region', () => {
    expect(covered(microInstance(), [ec2Hours(10, 30, 'eu-west-1')])).toBe('covered')
  })

  it('ignores an allowance for another region', () => {
    expect(covered(microInstance(), [ec2Hours(10, 30, 'us-east-1')])).toBe('not-covered')
  })

  it('is not covered when any one matching allowance is used up', () => {
    const usage = [ec2Hours(10, 30), row('EU-BoxUsage:freetier.micro', 800, 800, 750, 'eu-west-1')]
    expect(covered(microInstance(), usage)).toBe('not-covered')
  })

  it.each([
    ['actual use', ec2Hours(null, 30)],
    ['the forecast', ec2Hours(10, null)]
  ])('is not covered when AWS does not report %s: "within the allowance" must be shown, not assumed', (_what, usage) => {
    expect(covered(microInstance(), [usage])).toBe('not-covered')
  })

  it('treats use exactly at the limit as within it', () => {
    expect(covered(microInstance(), [ec2Hours(750, 750)])).toBe('covered')
  })

  it('does not match a usage type that merely contains the same letters', () => {
    expect(covered(microInstance(), [row('Global-DedicatedBoxUsage:freetier.micro', 10, 30, 750)])).toBe('not-covered')
  })
})

describe('planNotice, the account-wide message', () => {
  it('says the plan is unavailable when it could not be read', () => {
    expect(planNotice(null)).toEqual({ text: 'Plan details unavailable for this account. Showing resources only.', critical: false })
  })

  it('is critical for an expired plan', () => {
    expect(planNotice(plan({ planType: 'FREE', status: 'EXPIRED' }))).toEqual({
      text: 'The account plan has expired. Nothing running is paid for by credits or the free plan any more.',
      critical: true
    })
  })

  it('is critical for a free plan whose credits are used up', () => {
    expect(planNotice(plan({ planType: 'FREE', remainingCreditsUsd: 0 }))?.critical).toBe(true)
  })

  it('explains credits on the free plan and on a paid plan', () => {
    expect(planNotice(plan({ planType: 'FREE', remainingCreditsUsd: 150.5 }))).toEqual({
      text: 'Paid from credits. The account closes when they run out.',
      critical: false
    })
    expect(planNotice(plan({ remainingCreditsUsd: 42 }))).toEqual({
      text: 'Paid from credits. You are charged once they run out.',
      critical: false
    })
  })

  it('has nothing to say for an ordinary paid account without credits', () => {
    expect(planNotice(plan())).toBeNull()
  })
})
