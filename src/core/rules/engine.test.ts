import { describe, expect, it } from 'vitest'
import type { AttrValue, PlanState, ResourceKind, RuleSetting, Runway } from '../../shared/types'
import { evaluateRules, type RuleInput, type RuleResource } from './engine'
import type { CpuReading } from './idle'
import { ruleParams, RULES } from './rules'

const NOW = new Date('2026-11-10T12:00:00.000Z')
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString()

let nextId = 0
function make(kind: ResourceKind, state: string, attrs: Record<string, AttrValue> = {}, over: Partial<RuleResource> = {}): RuleResource {
  const id = `r${++nextId}`
  return { key: `111122223333:${kind}:eu-west-1:${id}`, kind, region: 'eu-west-1', id, state, attrs, stale: false, ...over }
}

const instance = (state = 'running', attrs: Record<string, AttrValue> = {}, over: Partial<RuleResource> = {}) =>
  make('ec2-instance', state, { instanceType: 't3.micro', ...attrs }, { createdAt: hoursAgo(1), ...over })
const endpoint = (instanceType: string | null, state = 'in-service', over: Partial<RuleResource> = {}) =>
  make(
    'sagemaker-endpoint',
    state,
    { variants: JSON.stringify([{ name: 'v', instanceType, instanceCount: 1, serverless: instanceType === null, shadow: false }]) },
    { createdAt: hoursAgo(1), ...over }
  )

function run(resources: RuleResource[], over: Partial<RuleInput> = {}) {
  return evaluateRules({ resources, plan: null, runway: null, settings: {}, cpu: null, now: NOW, ...over })
}
/** [ruleId, resourceKey] of every flag raised, sorted. */
const raised = (resources: RuleResource[], over: Partial<RuleInput> = {}) =>
  run(resources, over)
    .drafts.map((d) => `${d.ruleId} ${d.resourceKey ?? 'account'}`)
    .sort()
const only = (ruleId: string, resources: RuleResource[], over: Partial<RuleInput> = {}) =>
  run(resources, over).drafts.filter((d) => d.ruleId === ruleId)

describe('long-running', () => {
  it('flags an instance running for more than 24 hours, with the duration in the message', () => {
    const [flag] = only('long-running', [instance('running', {}, { createdAt: hoursAgo(25) })])
    expect(flag).toMatchObject({ severity: 'warn', message: 'Running for 25 hours.' })
  })

  it('does not flag at exactly 24 hours', () => {
    expect(only('long-running', [instance('running', {}, { createdAt: hoursAgo(24) })])).toEqual([])
  })

  it('speaks in days from two days on', () => {
    const [flag] = only('long-running', [instance('running', {}, { createdAt: hoursAgo(73) })])
    expect(flag!.message).toBe('Running for 3 days.')
  })

  it('uses the threshold from settings', () => {
    const settings = { 'long-running': { enabled: true, params: { hours: 2 } } }
    expect(only('long-running', [instance('running', {}, { createdAt: hoursAgo(3) })], { settings })).toHaveLength(1)
    expect(only('long-running', [instance('running', {}, { createdAt: hoursAgo(1.5) })], { settings })).toHaveLength(0)
  })

  it('also covers available databases and in-service endpoints', () => {
    const db = make('rds-instance', 'available', {}, { createdAt: hoursAgo(30) })
    const ep = endpoint('ml.t2.medium', 'in-service', { createdAt: hoursAgo(30) })
    expect(only('long-running', [db, ep])).toHaveLength(2)
  })

  it.each([
    ['a stopped instance', instance('stopped', {}, { createdAt: hoursAgo(100) })],
    ['a stopped database', make('rds-instance', 'stopped', {}, { createdAt: hoursAgo(100) })],
    ['an instance with no start time', make('ec2-instance', 'running', { instanceType: 't3.micro' })],
    ['a volume', make('ebs-volume', 'in-use', {}, { createdAt: hoursAgo(100) })]
  ])('does not flag %s', (_name, resource) => {
    expect(only('long-running', [resource])).toEqual([])
  })
})

describe('simple state rules', () => {
  it('flags every NAT gateway', () => {
    const nat = make('nat-gateway', 'available')
    expect(only('nat-gateway', [nat])).toEqual([
      {
        ruleId: 'nat-gateway',
        resourceKey: nat.key,
        severity: 'warn',
        message: 'A NAT gateway bills every hour it exists, plus a charge per GB it processes.'
      }
    ])
  })

  it('flags a volume attached to nothing, and not one in use', () => {
    expect(only('unattached-volume', [make('ebs-volume', 'available')])).toHaveLength(1)
    expect(only('unattached-volume', [make('ebs-volume', 'in-use'), make('ebs-volume', 'creating')])).toEqual([])
  })

  it('flags an Elastic IP attached to nothing, and not one in use', () => {
    expect(only('unassociated-ip', [make('elastic-ip', 'unassociated')])).toHaveLength(1)
    expect(only('unassociated-ip', [make('elastic-ip', 'associated')])).toEqual([])
  })

  it('notes, as information, that a stopped instance or database still pays for storage', () => {
    const flags = only('stopped-storage', [instance('stopped'), make('rds-instance', 'stopped'), instance('running')])
    expect(flags.map((f) => f.severity)).toEqual(['info', 'info'])
  })
})

describe('gpu-instance', () => {
  it.each(['p3.2xlarge', 'p5.48xlarge', 'g4dn.xlarge', 'g5.xlarge', 'g6e.2xlarge', 'g5g.xlarge'])('flags a running %s as critical', (type) => {
    const [flag] = only('gpu-instance', [instance('running', { instanceType: type })])
    expect(flag).toMatchObject({ severity: 'critical', message: `GPU instance (${type}).` })
  })

  it.each(['t3.micro', 'm5.large', 'c7g.large', 'r6g.xlarge', 'i3.large', 'gr.large', 'p.large'])('does not flag %s', (type) => {
    expect(only('gpu-instance', [instance('running', { instanceType: type })])).toEqual([])
  })

  it('does not flag a stopped GPU instance, or one with no type', () => {
    expect(only('gpu-instance', [instance('stopped', { instanceType: 'g5.xlarge' }), instance('running', { instanceType: null })])).toEqual([])
  })

  it('flags a SageMaker endpoint with a GPU variant', () => {
    const [flag] = only('gpu-instance', [endpoint('ml.g4dn.xlarge')])
    expect(flag!.message).toBe('GPU instance (ml.g4dn.xlarge).')
  })

  it('does not flag a CPU or serverless endpoint, or one whose variants cannot be read', () => {
    const broken = make('sagemaker-endpoint', 'in-service', { variants: '{oops' })
    expect(only('gpu-instance', [endpoint('ml.m5.large'), endpoint(null), broken])).toEqual([])
  })
})

describe('idle-cpu', () => {
  const reading = (maxCpu: number | null, datapoints: number): CpuReading => ({ maxCpu, datapoints, windowEnd: NOW.toISOString() })
  const idle = (resource: RuleResource, r: CpuReading | undefined, over: Partial<RuleInput> = {}) => {
    const result = run([resource], { cpu: new Map(r ? [[resource.key, r]] : []), ...over })
    return {
      flags: result.drafts.filter((d) => d.ruleId === 'idle-cpu'),
      undecided: result.undecided.has(`idle-cpu|${resource.key}`)
    }
  }

  it('flags an instance whose CPU stayed under 2% for the whole 6-hour window', () => {
    const { flags, undecided } = idle(instance(), reading(1.4, 6))
    expect(flags).toEqual([expect.objectContaining({ severity: 'warn', message: 'CPU never went above 1.4% in the last 6 hours.' })])
    expect(undecided).toBe(false)
  })

  it('does not flag at exactly 2%: that is a clear "not idle"', () => {
    expect(idle(instance(), reading(2, 6))).toEqual({ flags: [], undecided: false })
  })

  it('never flags on partial data, and leaves the question open', () => {
    expect(idle(instance(), reading(0.5, 5))).toEqual({ flags: [], undecided: true })
  })

  it('never flags on missing data, and leaves the question open', () => {
    expect(idle(instance(), reading(null, 0))).toEqual({ flags: [], undecided: true })
    expect(idle(instance(), undefined)).toEqual({ flags: [], undecided: true })
  })

  it('leaves the question open for every candidate when CloudWatch was not read at all', () => {
    const resource = instance()
    const result = run([resource], { cpu: null })
    expect(result.drafts.filter((d) => d.ruleId === 'idle-cpu')).toEqual([])
    expect(result.undecided.has(`idle-cpu|${resource.key}`)).toBe(true)
  })

  it('uses the threshold and window from settings', () => {
    const settings = { 'idle-cpu': { enabled: true, params: { windowHours: 12, maxCpuPercent: 10 } } }
    expect(idle(instance(), reading(9, 12), { settings }).flags).toHaveLength(1)
    // 6 datapoints no longer fill the window
    expect(idle(instance(), reading(1, 6), { settings })).toEqual({ flags: [], undecided: true })
  })

  it('covers available databases', () => {
    expect(idle(make('rds-instance', 'available'), reading(0.3, 6)).flags).toHaveLength(1)
  })

  it('clearly does not apply to a stopped instance, so an old flag can resolve', () => {
    expect(idle(instance('stopped'), reading(0.1, 6))).toEqual({ flags: [], undecided: false })
  })
})

describe('account rules', () => {
  const plan = (over: Partial<PlanState> = {}): PlanState => ({
    planType: 'FREE',
    status: 'ACTIVE',
    remainingCreditsUsd: 50,
    expiresAt: null,
    fetchedAt: NOW.toISOString(),
    ...over
  })
  const runway = (days: number | null, isUpperBound = false): Runway => ({ creditDays: days, planDays: null, days, isUpperBound })

  it('flags a runway under 14 days as critical, for the account', () => {
    expect(only('low-runway', [], { plan: plan(), runway: runway(13.9) })).toEqual([
      { ruleId: 'low-runway', resourceKey: null, severity: 'critical', message: 'Credits or the plan run out in about 13 days.' }
    ])
  })

  it('says "at most" when the runway is an upper bound', () => {
    const [flag] = only('low-runway', [], { plan: plan(), runway: runway(5.2, true) })
    expect(flag!.message).toBe('Credits or the plan run out in at most 5 days.')
  })

  it('says "less than a day" at the end', () => {
    const [flag] = only('low-runway', [], { plan: plan(), runway: runway(0.4) })
    expect(flag!.message).toBe('Credits or the plan run out in less than a day.')
  })

  it('does not flag at exactly 14 days, or when there is no limit', () => {
    expect(only('low-runway', [], { plan: plan(), runway: runway(14) })).toEqual([])
    expect(only('low-runway', [], { plan: plan(), runway: runway(null) })).toEqual([])
  })

  it('uses the threshold from settings', () => {
    const settings = { 'low-runway': { enabled: true, params: { days: 30 } } }
    expect(only('low-runway', [], { plan: plan(), runway: runway(20), settings })).toHaveLength(1)
  })

  it('leaves the expired plan to its own rule', () => {
    const expired = { plan: plan({ status: 'EXPIRED' }), runway: runway(0) }
    expect(raised([], expired)).toEqual(['plan-expired account'])
  })

  it('flags an expired plan as critical', () => {
    const [flag] = only('plan-expired', [], { plan: plan({ status: 'EXPIRED' }), runway: runway(0) })
    expect(flag).toMatchObject({ resourceKey: null, severity: 'critical' })
  })

  it('leaves both account questions open when the plan could not be read', () => {
    const result = run([], { plan: null, runway: null })
    expect(result.drafts).toEqual([])
    expect([...result.undecided].sort()).toEqual(['low-runway|account', 'plan-expired|account'])
  })
})

describe('the engine', () => {
  it('raises nothing for an empty, healthy account', () => {
    const plan: PlanState = { planType: 'PAID', status: 'ACTIVE', remainingCreditsUsd: null, expiresAt: null, fetchedAt: NOW.toISOString() }
    const result = run([], { plan, runway: { creditDays: null, planDays: null, days: null, isUpperBound: false } })
    expect(result.drafts).toEqual([])
    expect(result.undecided.size).toBe(0)
  })

  it('raises several flags for one resource when several rules match', () => {
    const gpu = instance('running', { instanceType: 'g5.xlarge' }, { createdAt: hoursAgo(30) })
    expect(raised([gpu], { cpu: new Map() })).toEqual([`gpu-instance ${gpu.key}`, `long-running ${gpu.key}`])
  })

  it('does not evaluate a stale resource: every rule is left open for it, so its flags neither appear nor resolve', () => {
    const stale = make('nat-gateway', 'available', {}, { stale: true })
    const result = run([stale])
    expect(result.drafts).toEqual([])
    for (const rule of RULES.filter((r) => r.scope === 'resource')) {
      expect(result.undecided.has(`${rule.id}|${stale.key}`)).toBe(true)
    }
  })

  it('skips a rule that is switched off, without leaving it open: its old flags resolve', () => {
    const nat = make('nat-gateway', 'available')
    const result = run([nat], { settings: { 'nat-gateway': { enabled: false, params: {} } } })
    expect(result.drafts).toEqual([])
    expect(result.undecided.has(`nat-gateway|${nat.key}`)).toBe(false)
  })

  it('has every rule on by default', () => {
    expect(RULES.map((rule) => rule.id).sort()).toEqual([
      'gpu-instance',
      'idle-cpu',
      'long-running',
      'low-runway',
      'nat-gateway',
      'plan-expired',
      'stopped-storage',
      'unassociated-ip',
      'unattached-volume'
    ])
    const nat = make('nat-gateway', 'available')
    expect(raised([nat])).toEqual([`nat-gateway ${nat.key}`])
  })
})

describe('ruleParams', () => {
  const settings = (params: Record<string, number>): Record<string, RuleSetting> => ({ 'idle-cpu': { enabled: true, params } })

  it('returns the defaults when settings say nothing', () => {
    expect(ruleParams({}, 'idle-cpu')).toEqual({ windowHours: 6, maxCpuPercent: 2 })
  })

  it('overrides only the parameters that are set', () => {
    expect(ruleParams(settings({ maxCpuPercent: 5 }), 'idle-cpu')).toEqual({ windowHours: 6, maxCpuPercent: 5 })
  })

  it.each([Number.NaN, -1, 0, Number.POSITIVE_INFINITY])('falls back to the default for a useless value (%s)', (value) => {
    expect(ruleParams(settings({ windowHours: value }), 'idle-cpu').windowHours).toBe(6)
  })

  it('ignores parameters the rule does not have', () => {
    expect(ruleParams(settings({ banana: 3 }), 'idle-cpu')).toEqual({ windowHours: 6, maxCpuPercent: 2 })
  })
})
