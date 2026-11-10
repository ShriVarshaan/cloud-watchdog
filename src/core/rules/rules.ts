// The rules. Each one is a pure function that looks at one resource (or at the
// account) and answers one of three things:
//
//   { message }   the rule matches: raise or keep a flag
//   null          it clearly does not match: an existing flag is resolved
//   'undecided'   there is not enough data to say: an existing flag is left
//                 exactly as it is, and no new one is raised
//
// 'undecided' is what keeps the app from crying wolf and from going quiet by
// accident. Missing CloudWatch data never raises an idle flag, and never
// clears one either.
//
// Rules hold no state and call nothing. Whether a rule is on, and its
// thresholds, come from settings (see `ruleParams`); every rule is on by default.

import type { PlanState, Resource, RuleSetting, Runway, Severity } from '../../shared/types'
import type { CpuReading } from './idle'

export type Verdict = { message: string } | null | 'undecided'

export interface RuleContext {
  now: Date
  /** This rule's thresholds: its defaults with the user's overrides applied. */
  params: Record<string, number>
  /** CPU readings by resource key. null = CloudWatch was not read in this scan. */
  cpu: ReadonlyMap<string, CpuReading> | null
  /** null = the plan could not be read. */
  plan: PlanState | null
  runway: Runway | null
}

interface RuleBase {
  id: string
  severity: Severity
  /** Default thresholds. Empty for rules that have none. */
  params: Record<string, number>
}
export interface ResourceRule extends RuleBase {
  scope: 'resource'
  evaluate(resource: Resource, ctx: RuleContext): Verdict
}
export interface AccountRule extends RuleBase {
  scope: 'account'
  evaluate(ctx: RuleContext): Verdict
}
export type Rule = ResourceRule | AccountRule

const HOUR_MS = 3_600_000

/** The things that bill by the hour while they are up, and the state in which they do. */
const RUNNING_STATE: Partial<Record<Resource['kind'], string>> = {
  'ec2-instance': 'running',
  'rds-instance': 'available',
  'sagemaker-endpoint': 'in-service'
}
const isUp = (resource: Resource) => RUNNING_STATE[resource.kind] === resource.state

/**
 * GPU families, for EC2 ("g5.xlarge") and SageMaker ("ml.g5.xlarge"): every
 * P family (p3, p4d, p5, ...) and every G family (g4dn, g5, g5g, g6e, ...).
 */
const GPU_TYPE = /^(?:ml\.)?[pg]\d/

function instanceTypes(resource: Resource): string[] {
  if (resource.kind === 'ec2-instance') {
    return typeof resource.attrs.instanceType === 'string' ? [resource.attrs.instanceType] : []
  }
  if (resource.kind === 'sagemaker-endpoint') {
    try {
      const variants: unknown = JSON.parse(String(resource.attrs.variants))
      if (!Array.isArray(variants)) return []
      return variants.flatMap((variant: { instanceType?: unknown }) =>
        typeof variant?.instanceType === 'string' ? [variant.instanceType] : []
      )
    } catch {
      return []
    }
  }
  return []
}

export const RULES: readonly Rule[] = [
  {
    id: 'long-running',
    scope: 'resource',
    severity: 'warn',
    params: { hours: 24 },
    // For EC2, createdAt is the time of the latest start. For a database it is the creation time.
    evaluate(resource, { now, params }) {
      if (!isUp(resource) || !resource.createdAt) return null
      const hours = (now.getTime() - Date.parse(resource.createdAt)) / HOUR_MS
      if (!(hours > params.hours!)) return null
      return { message: hours < 48 ? `Running for ${Math.floor(hours)} hours.` : `Running for ${Math.floor(hours / 24)} days.` }
    }
  },
  {
    id: 'nat-gateway',
    scope: 'resource',
    severity: 'warn',
    params: {},
    evaluate: (resource) =>
      resource.kind === 'nat-gateway'
        ? { message: 'A NAT gateway bills every hour it exists, plus a charge per GB it processes.' }
        : null
  },
  {
    id: 'unattached-volume',
    scope: 'resource',
    severity: 'warn',
    params: {},
    evaluate: (resource) =>
      resource.kind === 'ebs-volume' && resource.state === 'available'
        ? { message: 'This volume is attached to nothing and still bills for its full size.' }
        : null
  },
  {
    id: 'unassociated-ip',
    scope: 'resource',
    severity: 'warn',
    params: {},
    evaluate: (resource) =>
      resource.kind === 'elastic-ip' && resource.state === 'unassociated'
        ? { message: 'This Elastic IP is attached to nothing and still bills by the hour.' }
        : null
  },
  {
    id: 'gpu-instance',
    scope: 'resource',
    severity: 'critical',
    params: {},
    evaluate(resource) {
      if (!isUp(resource)) return null
      const gpu = instanceTypes(resource).find((type) => GPU_TYPE.test(type))
      return gpu ? { message: `GPU instance (${gpu}).` } : null
    }
  },
  {
    id: 'idle-cpu',
    scope: 'resource',
    severity: 'warn',
    params: { windowHours: 6, maxCpuPercent: 2 },
    evaluate(resource, { cpu, params }) {
      if (resource.kind !== 'ec2-instance' && resource.kind !== 'rds-instance') return null
      if (!isUp(resource)) return null

      const reading = cpu?.get(resource.key)
      // One datapoint per hour: fewer than the window has hours means part of it is not covered.
      if (!reading || reading.maxCpu === null || reading.datapoints < params.windowHours!) return 'undecided'
      if (!(reading.maxCpu < params.maxCpuPercent!)) return null
      const peak = Math.round(reading.maxCpu * 10) / 10
      return { message: `CPU never went above ${peak}% in the last ${params.windowHours} hours.` }
    }
  },
  {
    id: 'stopped-storage',
    scope: 'resource',
    severity: 'info',
    params: {},
    evaluate(resource) {
      if (resource.state !== 'stopped') return null
      if (resource.kind === 'ec2-instance') return { message: 'Stopped, but its volumes still bill for storage.' }
      if (resource.kind === 'rds-instance') return { message: 'Stopped, but its storage and backups still bill.' }
      return null
    }
  },
  {
    id: 'low-runway',
    scope: 'account',
    severity: 'critical',
    params: { days: 14 },
    evaluate({ plan, runway, params }) {
      if (!plan) return 'undecided'
      // An expired plan has its own rule and its own message.
      if (plan.status === 'EXPIRED' || !runway || runway.days === null) return null
      if (!(runway.days < params.days!)) return null
      const whole = Math.floor(runway.days)
      if (whole < 1) return { message: 'Credits or the plan run out in less than a day.' }
      const qualifier = runway.isUpperBound ? 'at most' : 'about'
      return { message: `Credits or the plan run out in ${qualifier} ${whole} ${whole === 1 ? 'day' : 'days'}.` }
    }
  },
  {
    id: 'plan-expired',
    scope: 'account',
    severity: 'critical',
    params: {},
    evaluate({ plan }) {
      if (!plan) return 'undecided'
      return plan.status === 'EXPIRED'
        ? { message: 'The account plan has expired. Nothing running is covered by credits or the free plan.' }
        : null
    }
  }
]

/** Whether the rule is on. A rule the settings do not mention is on. */
export function ruleEnabled(settings: Readonly<Record<string, RuleSetting>>, ruleId: string): boolean {
  return settings[ruleId]?.enabled ?? true
}

/** A rule's thresholds: its defaults, with each valid override from settings applied. */
export function ruleParams(settings: Readonly<Record<string, RuleSetting>>, ruleId: string): Record<string, number> {
  const rule = RULES.find((candidate) => candidate.id === ruleId)
  if (!rule) return {}
  const overrides = settings[ruleId]?.params ?? {}
  const params: Record<string, number> = {}
  for (const [name, fallback] of Object.entries(rule.params)) {
    const value = overrides[name]
    // Every threshold is a positive number. Anything else would switch a rule off or make it fire always.
    params[name] = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
  }
  return params
}
