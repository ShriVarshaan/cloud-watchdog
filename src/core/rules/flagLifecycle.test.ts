import { beforeEach, describe, expect, it } from 'vitest'
import type { Flag } from '../../shared/types'
import { openDb } from '../store/db'
import { migrate } from '../store/migrations'
import { createRepo, type Repo } from '../store/repo'
import type { FlagDraft, RuleOutcome } from './engine'
import { DISMISSED_UNTIL_RESOLVED, isDismissed, reconcileFlags, updateFlags } from './flagLifecycle'

const ACCOUNT = '111122223333'
const NAT = `${ACCOUNT}:nat-gateway:eu-west-1:nat-1`
const T1 = new Date('2026-11-10T12:00:00.000Z')
const T2 = new Date('2026-11-10T12:15:00.000Z')
const T3 = new Date('2026-11-10T12:30:00.000Z')

const natDraft = (message = 'A NAT gateway bills every hour.'): FlagDraft => ({
  ruleId: 'nat-gateway',
  resourceKey: NAT,
  severity: 'warn',
  message
})
const outcome = (drafts: FlagDraft[] = [], undecided: string[] = []): RuleOutcome => ({ drafts, undecided: new Set(undecided) })

/** Ids f1, f2, ... in the order flags are created. */
function ids() {
  let n = 0
  return () => `f${++n}`
}

describe('reconcileFlags', () => {
  it('raises a new flag once, stamped with the time it was first seen', () => {
    const changes = reconcileFlags([], outcome([natDraft()]), T1, ids())
    const flag: Flag = {
      id: 'f1',
      ruleId: 'nat-gateway',
      resourceKey: NAT,
      severity: 'warn',
      message: 'A NAT gateway bills every hour.',
      firstSeenAt: T1.toISOString()
    }
    expect(changes).toEqual({ open: [flag], raised: [flag], resolved: [] })
  })

  it('keeps a flag that still matches, without raising it again', () => {
    const first = reconcileFlags([], outcome([natDraft()]), T1, ids())
    const second = reconcileFlags(first.open, outcome([natDraft()]), T2, ids())

    expect(second.raised).toEqual([])
    expect(second.resolved).toEqual([])
    expect(second.open).toEqual(first.open)
  })

  it('takes over a changed message or severity without raising again', () => {
    const first = reconcileFlags([], outcome([natDraft('Running for 25 hours.')]), T1, ids())
    const second = reconcileFlags(first.open, outcome([{ ...natDraft('Running for 26 hours.'), severity: 'critical' }]), T2, ids())

    expect(second.raised).toEqual([])
    expect(second.open).toEqual([{ ...first.open[0]!, message: 'Running for 26 hours.', severity: 'critical' }])
  })

  it('resolves a flag whose rule clearly no longer matches', () => {
    const first = reconcileFlags([], outcome([natDraft()]), T1, ids())
    const second = reconcileFlags(first.open, outcome(), T2, ids())

    expect(second.open).toEqual([])
    expect(second.resolved).toEqual([{ ...first.open[0]!, resolvedAt: T2.toISOString() }])
  })

  it('leaves a flag untouched when the rule could not judge (stale resource, missing data)', () => {
    const first = reconcileFlags([], outcome([natDraft()]), T1, ids())
    const second = reconcileFlags(first.open, outcome([], [`nat-gateway|${NAT}`]), T2, ids())

    expect(second).toEqual({ open: first.open, raised: [], resolved: [] })
  })

  it('raises nothing for an undecided rule that has no flag yet', () => {
    expect(reconcileFlags([], outcome([], [`nat-gateway|${NAT}`]), T1, ids())).toEqual({ open: [], raised: [], resolved: [] })
  })

  it('raises a flag again, as a new one, after it was resolved', () => {
    const first = reconcileFlags([], outcome([natDraft()]), T1, ids())
    const gone = reconcileFlags(first.open, outcome(), T2, ids())
    const back = reconcileFlags(gone.open, outcome([natDraft()]), T3, () => 'f-new')

    expect(back.raised).toEqual([expect.objectContaining({ id: 'f-new', firstSeenAt: T3.toISOString() })])
    expect(back.raised[0]).not.toHaveProperty('resolvedAt')
  })

  it('treats two rules on one resource, and one rule on two resources, as separate flags', () => {
    const other = `${ACCOUNT}:nat-gateway:us-east-1:nat-2`
    const drafts = [natDraft(), { ...natDraft(), ruleId: 'long-running' }, { ...natDraft(), resourceKey: other }]
    const first = reconcileFlags([], outcome(drafts), T1, ids())
    expect(first.raised).toHaveLength(3)

    const second = reconcileFlags(first.open, outcome([natDraft()]), T2, ids())
    expect(second.open.map((f) => f.id)).toEqual(['f1'])
    expect(second.resolved.map((f) => f.id).sort()).toEqual(['f2', 'f3'])
  })

  it('handles flags about the account, which have no resource', () => {
    const runway: FlagDraft = { ruleId: 'low-runway', resourceKey: null, severity: 'critical', message: 'Runs out in about 5 days.' }
    const first = reconcileFlags([], outcome([runway]), T1, ids())
    expect(first.raised[0]!.resourceKey).toBeNull()

    expect(reconcileFlags(first.open, outcome([], ['low-runway|account']), T2, ids()).open).toEqual(first.open)
    expect(reconcileFlags(first.open, outcome(), T2, ids()).resolved).toHaveLength(1)
  })
})

describe('dismissing', () => {
  it('keeps a dismissed flag dismissed while it still matches, without raising it again', () => {
    const first = reconcileFlags([], outcome([natDraft()]), T1, ids())
    const dismissed = [{ ...first.open[0]!, dismissedUntil: DISMISSED_UNTIL_RESOLVED }]
    const second = reconcileFlags(dismissed, outcome([natDraft()]), T2, ids())

    expect(second.raised).toEqual([])
    expect(second.open[0]!.dismissedUntil).toBe(DISMISSED_UNTIL_RESOLVED)
  })

  it('forgets the dismissal when the flag resolves: if it comes back it is new, visible and raised', () => {
    const first = reconcileFlags([], outcome([natDraft()]), T1, ids())
    const dismissed = [{ ...first.open[0]!, dismissedUntil: DISMISSED_UNTIL_RESOLVED }]
    const gone = reconcileFlags(dismissed, outcome(), T2, ids())
    const back = reconcileFlags(gone.open, outcome([natDraft()]), T3, ids())

    expect(back.raised).toHaveLength(1)
    expect(back.raised[0]).not.toHaveProperty('dismissedUntil')
    expect(isDismissed(back.raised[0]!, T3)).toBe(false)
  })

  it('isDismissed: hidden until its time, shown again from that moment', () => {
    const flag: Flag = { ...reconcileFlags([], outcome([natDraft()]), T1, ids()).open[0]!, dismissedUntil: T2.toISOString() }
    expect(isDismissed(flag, T1)).toBe(true)
    expect(isDismissed(flag, T2)).toBe(false)
    expect(isDismissed(flag, T3)).toBe(false)
  })

  it('isDismissed: "until it resolves" never times out, and a flag that was never dismissed is shown', () => {
    const flag = reconcileFlags([], outcome([natDraft()]), T1, ids()).open[0]!
    expect(isDismissed({ ...flag, dismissedUntil: DISMISSED_UNTIL_RESOLVED }, new Date('2099-01-01T00:00:00.000Z'))).toBe(true)
    expect(isDismissed(flag, T1)).toBe(false)
  })
})

describe('updateFlags, with the store', () => {
  let repo: Repo
  beforeEach(() => {
    const db = openDb(':memory:')
    migrate(db)
    repo = createRepo(db)
  })

  it('saves a raised flag and returns it for notification once', () => {
    const first = updateFlags(repo, ACCOUNT, outcome([natDraft()]), T1)
    expect(first.raised).toHaveLength(1)
    expect(repo.listFlags(ACCOUNT)).toEqual(first.open)

    const second = updateFlags(repo, ACCOUNT, outcome([natDraft()]), T2)
    expect(second.raised).toEqual([])
    expect(repo.listFlags(ACCOUNT)).toHaveLength(1)
  })

  it('saves the resolution, so the flag is no longer open', () => {
    updateFlags(repo, ACCOUNT, outcome([natDraft()]), T1)
    updateFlags(repo, ACCOUNT, outcome(), T2)

    expect(repo.listFlags(ACCOUNT)).toEqual([])
    expect(repo.listFlags(ACCOUNT, { includeResolved: true })).toEqual([expect.objectContaining({ resolvedAt: T2.toISOString() })])
  })

  it('keeps a dismissal made through the store while the flag still matches', () => {
    const { open } = updateFlags(repo, ACCOUNT, outcome([natDraft()]), T1)
    repo.setFlagDismissedUntil(open[0]!.id, DISMISSED_UNTIL_RESOLVED)

    updateFlags(repo, ACCOUNT, outcome([natDraft('Still here.')]), T2)
    expect(repo.listFlags(ACCOUNT)).toEqual([expect.objectContaining({ message: 'Still here.', dismissedUntil: DISMISSED_UNTIL_RESOLVED })])
  })

  it('does not resolve a stale resource\'s flag, and creates a second flag only after a real resolution', () => {
    updateFlags(repo, ACCOUNT, outcome([natDraft()]), T1)
    updateFlags(repo, ACCOUNT, outcome([], [`nat-gateway|${NAT}`]), T2)
    expect(repo.listFlags(ACCOUNT)).toHaveLength(1)

    updateFlags(repo, ACCOUNT, outcome(), T2)
    const back = updateFlags(repo, ACCOUNT, outcome([natDraft()]), T3)
    expect(back.raised).toHaveLength(1)
    expect(repo.listFlags(ACCOUNT, { includeResolved: true })).toHaveLength(2)
  })

  it('leaves another account\'s flags alone', () => {
    updateFlags(repo, '999900001111', outcome([{ ...natDraft(), resourceKey: '999900001111:nat-gateway:eu-west-1:nat-9' }]), T1)
    updateFlags(repo, ACCOUNT, outcome(), T2)
    expect(repo.listFlags('999900001111')).toHaveLength(1)
  })
})
