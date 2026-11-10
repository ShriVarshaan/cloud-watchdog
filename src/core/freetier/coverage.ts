// Is a resource paid for by something other than the user's money?
//
// The decision table (PLAN.md, M6), top to bottom, first match wins:
//
//   plan not known                         unknown
//   plan EXPIRED                           not-covered
//   credits left (free or paid plan)       covered      credits pay for everything
//   FREE plan, credits used up             not-covered
//   FREE plan, no credit figure            unknown
//   PAID plan, no credits:
//     usage not known                      unknown
//     no matching free allowance           not-covered
//     allowance with room this month       covered
//     allowance used up or forecast over   not-covered
//
// The costly mistake is "covered" for something the user pays for, so every
// doubt goes the other way: a missing figure, an unknown usage type or an
// instance type outside the list below is never "covered".
//
// Verified against a recording: a free-plan account returns rows with region
// "global" and type "Always Free" (tests/fixtures/freeTier.ts). NOT verified,
// because the test account is on the free plan: the usage types of the
// "12 Months Free" allowances that older accounts have, and which resources
// they apply to. The ALLOWANCES table is from AWS's free tier documentation.

import { CREDITS_FREE_PLAN, CREDITS_PAID_PLAN, PLAN_UNAVAILABLE } from '../../shared/plan'
import type { Coverage, PlanState, Resource } from '../../shared/types'
import type { FreeTierUsageRow } from './planState'

export interface CoverageDecision {
  coverage: Coverage
  /** A short reason for the UI, or null when the plan notice already says it. */
  message: string | null
}


interface Allowance {
  /** Matches the usage type after its "Global-" or region prefix is removed. */
  usageType: RegExp
  /** Whether this resource is the kind of thing the allowance is for. */
  applies(resource: Resource): boolean
}

const isOneOf = (value: unknown, allowed: readonly string[]) => typeof value === 'string' && allowed.includes(value)

/** Per resource kind. Kinds that are missing (NAT gateways, SageMaker endpoints) have no free allowance. */
const ALLOWANCES: Partial<Record<Resource['kind'], Allowance>> = {
  'ec2-instance': {
    usageType: /^BoxUsage:/,
    applies: ({ attrs }) =>
      isOneOf(attrs.instanceType, ['t2.micro', 't3.micro']) && attrs.tenancy === 'default' && attrs.lifecycle === 'on-demand'
  },
  'ebs-volume': {
    usageType: /^EBS:VolumeUsage/,
    applies: ({ attrs }) => isOneOf(attrs.volumeType, ['gp2', 'gp3', 'standard'])
  },
  'rds-instance': {
    usageType: /^InstanceUsage:db\./,
    applies: ({ attrs }) =>
      isOneOf(attrs.instanceClass, ['db.t2.micro', 'db.t3.micro', 'db.t4g.micro']) &&
      isOneOf(attrs.engine, ['mysql', 'postgres', 'mariadb', 'sqlserver-ex']) &&
      attrs.multiAz === false &&
      !attrs.clusterId
  },
  'load-balancer': {
    usageType: /^LoadBalancerUsage$/,
    applies: ({ attrs }) => isOneOf(attrs.type, ['classic', 'application'])
  },
  'elastic-ip': {
    usageType: /^PublicIPv4:InUseAddress$/,
    applies: (resource) => resource.state === 'associated'
  }
}

/** "Global-BoxUsage:x", "EU-BoxUsage:x", "USE2-BoxUsage:x" -> "BoxUsage:x". */
const USAGE_PREFIX = /^(?:Global|[A-Z]{3,4}\d|EU)-/

function hasRoom(row: FreeTierUsageRow): boolean {
  // A figure AWS did not report is not evidence of room.
  if (row.actualUsage === null || row.forecastedUsage === null) return false
  return row.actualUsage <= row.limit && row.forecastedUsage <= row.limit
}

function byAllowance(resource: Resource, usage: readonly FreeTierUsageRow[]): CoverageDecision {
  const allowance = ALLOWANCES[resource.kind]
  if (!allowance || !allowance.applies(resource)) return { coverage: 'not-covered', message: null }

  const rows = usage.filter(
    (row) =>
      (row.region === 'global' || row.region === resource.region) && allowance.usageType.test(row.usageType.replace(USAGE_PREFIX, ''))
  )
  if (rows.length === 0) return { coverage: 'not-covered', message: null }
  return rows.every(hasRoom)
    ? { coverage: 'covered', message: 'Within the monthly free allowance.' }
    : { coverage: 'not-covered', message: 'Free allowance used up.' }
}

/**
 * @param usage this month's free tier usage, or null when it was not fetched or the call failed
 */
export function decideCoverage(resource: Resource, plan: PlanState | null, usage: readonly FreeTierUsageRow[] | null): CoverageDecision {
  if (!plan) return { coverage: 'unknown', message: PLAN_UNAVAILABLE }
  if (plan.status === 'EXPIRED') return { coverage: 'not-covered', message: null }

  const credits = plan.remainingCreditsUsd
  if (credits !== null && credits > 0) {
    return { coverage: 'covered', message: plan.planType === 'FREE' ? CREDITS_FREE_PLAN : CREDITS_PAID_PLAN }
  }
  if (plan.planType === 'FREE') {
    // The free plan pays from credits only.
    return credits === null ? { coverage: 'unknown', message: 'AWS did not report the credit balance.' } : { coverage: 'not-covered', message: 'Credits used up.' }
  }

  if (!usage) return { coverage: 'unknown', message: null }
  return byAllowance(resource, usage)
}
