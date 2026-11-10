import { describe, expect, it } from 'vitest'
import type { BurnRate, Flag, PricedResource, ResourceKind, ScanSummary } from '../shared/types'
import { formatUsdPerHour, planToasts, trayTooltip } from './notifications'

const ACCOUNT = '111122223333'

function resource(kind: ResourceKind, id: string, name?: string): PricedResource {
  return {
    key: `${ACCOUNT}:${kind}:eu-west-1:${id}`,
    kind,
    region: 'eu-west-1',
    id,
    ...(name ? { name } : {}),
    state: 'running',
    attrs: {},
    price: { hourlyUsd: null, confidence: 'unknown', source: 'none', excluded: [] },
    coverage: 'unknown',
    stale: false
  }
}

let n = 0
function flag(ruleId: string, severity: Flag['severity'], resourceKey: string | null, message = `message ${ruleId}`): Flag {
  return { id: `f${++n}`, ruleId, resourceKey, severity, message, firstSeenAt: '2026-11-10T12:00:00.000Z' }
}

const nat = resource('nat-gateway', 'nat-0abc')
const gpu = resource('ec2-instance', 'i-0abc', 'training-box')

describe('planToasts', () => {
  it('shows nothing when nothing is new', () => {
    expect(planToasts([], [nat])).toEqual([])
  })

  it('shows one toast per new flag, naming the resource, and opening it on click', () => {
    expect(planToasts([flag('nat-gateway', 'warn', nat.key, 'A NAT gateway bills every hour.')], [nat])).toEqual([
      {
        title: 'NAT gateway nat-0abc (eu-west-1)',
        body: 'A NAT gateway bills every hour.',
        resourceKey: nat.key,
        urgent: false
      }
    ])
  })

  it('uses the resource name when it has one', () => {
    const [toast] = planToasts([flag('gpu-instance', 'critical', gpu.key)], [gpu])
    expect(toast).toMatchObject({ title: 'EC2 instance training-box (eu-west-1)', urgent: true })
  })

  it('titles a flag about the whole account as such', () => {
    const [toast] = planToasts([flag('low-runway', 'critical', null, 'Credits run out in about 5 days.')], [])
    expect(toast).toEqual({ title: 'AWS account', body: 'Credits run out in about 5 days.', resourceKey: null, urgent: true })
  })

  it('falls back to the key when the resource is not in the scan', () => {
    const [toast] = planToasts([flag('nat-gateway', 'warn', 'gone-key')], [])
    expect(toast!.title).toBe('gone-key')
  })

  it('shows up to three, most severe first', () => {
    const toasts = planToasts(
      [flag('nat-gateway', 'warn', nat.key), flag('stopped-storage', 'info', gpu.key), flag('gpu-instance', 'critical', gpu.key)],
      [nat, gpu]
    )
    expect(toasts.map((t) => t.urgent)).toEqual([true, false, false])
    expect(toasts.map((t) => t.body)).toEqual(['message gpu-instance', 'message nat-gateway', 'message stopped-storage'])
  })

  it('groups more than three into one toast that opens the main window', () => {
    const flags = [
      flag('nat-gateway', 'warn', nat.key),
      flag('gpu-instance', 'critical', gpu.key),
      flag('long-running', 'warn', gpu.key),
      flag('stopped-storage', 'info', gpu.key)
    ]
    expect(planToasts(flags, [nat, gpu])).toEqual([
      {
        title: '4 new warnings in your AWS account',
        body: '1 critical, 2 warnings, 1 note. Open Cloud Watchdog to see them.',
        resourceKey: null,
        urgent: true
      }
    ])
  })

  it('is not urgent when a group holds nothing critical', () => {
    const flags = [1, 2, 3, 4].map(() => flag('nat-gateway', 'warn', nat.key))
    expect(planToasts(flags, [nat])[0]).toMatchObject({ urgent: false, body: '4 warnings. Open Cloud Watchdog to see them.' })
  })
})

describe('formatUsdPerHour', () => {
  it.each([
    [0, '$0/h'],
    [0.0004, '<$0.001/h'],
    [0.0114, '$0.011/h'],
    [0.048, '$0.048/h'],
    [0.05, '$0.05/h'],
    [0.42, '$0.42/h'],
    [1.5, '$1.50/h'],
    [12.3456, '$12.35/h']
  ])('%s -> %s', (usd, text) => {
    expect(formatUsdPerHour(usd)).toBe(text)
  })
})

describe('trayTooltip', () => {
  const burn = (exactUsdPerHour: number, estimateUsdPerHour = 0, unknownCount = 0): BurnRate => ({
    exactUsdPerHour,
    estimateUsdPerHour,
    unknownCount
  })
  const summary = (b: BurnRate, openFlagCount = 0): ScanSummary => ({
    scanId: 's',
    finishedAt: '2026-11-10T12:00:00.000Z',
    burn: b,
    plan: null,
    runway: null,
    resourceCount: 3,
    openFlagCount,
    errorCount: 0
  })

  it('asks for a profile before one is chosen', () => {
    expect(trayTooltip({ hasProfile: false, summary: null, problem: null })).toBe('Cloud Watchdog: choose an AWS profile')
  })

  it('says it has not scanned yet', () => {
    expect(trayTooltip({ hasProfile: true, summary: null, problem: null })).toBe('Cloud Watchdog: no scan yet')
  })

  it('shows the exact rate alone when that is all there is', () => {
    expect(trayTooltip({ hasProfile: true, summary: summary(burn(0.42)), problem: null })).toBe('Cloud Watchdog\n$0.42/h')
  })

  it('keeps exact and estimated rates apart, and counts the unpriced and the warnings', () => {
    expect(trayTooltip({ hasProfile: true, summary: summary(burn(0.42, 0.05, 1), 2), problem: null })).toBe(
      'Cloud Watchdog\n$0.42/h + about $0.05/h estimated, 1 unpriced\n2 warnings'
    )
  })

  it('puts a sign-in problem first', () => {
    expect(trayTooltip({ hasProfile: true, summary: summary(burn(0.42)), problem: 'Sign-in expired' })).toBe(
      'Cloud Watchdog: Sign-in expired\n$0.42/h'
    )
  })

  it('never exceeds the 127 characters Windows shows', () => {
    const text = trayTooltip({ hasProfile: true, summary: summary(burn(0.42, 0.05, 1), 2), problem: 'x'.repeat(200) })
    expect(text.length).toBeLessThanOrEqual(127)
  })
})
