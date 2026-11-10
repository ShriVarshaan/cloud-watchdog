// What happens to flags from one scan to the next. A flag is identified by
// its rule and what it is about (`flagIdentity`).
//
//   the rule matches, no open flag    -> a new flag: raised, to be notified once
//   the rule matches, flag is open    -> kept; message and severity are
//                                        refreshed; never notified again
//   the rule clearly does not match   -> resolved
//   the rule could not judge          -> left exactly as it is. This is the
//                                        case for stale resources and missing
//                                        CloudWatch data.
//
// Dismissing hides a flag without resolving it: until a time, or until the
// flag resolves. A resolved flag is finished. If the rule matches again later
// that is a new flag, with a new id, no dismissal, and a new notification.

import { randomUUID } from 'node:crypto'
import type { Flag } from '../../shared/types'
import type { Repo } from '../store/repo'
import { flagIdentity, type RuleOutcome } from './engine'

/** `dismissedUntil` value meaning "hidden until the flag resolves". */
export const DISMISSED_UNTIL_RESOLVED = '9999-12-31T23:59:59.999Z'

export function isDismissed(flag: Flag, now: Date): boolean {
  return flag.dismissedUntil !== undefined && Date.parse(flag.dismissedUntil) > now.getTime()
}

export interface FlagChanges {
  /** Every flag that is open after this scan, dismissed ones included. */
  open: Flag[]
  /** New in this scan. These, and only these, are notified. */
  raised: Flag[]
  resolved: Flag[]
}

/**
 * @param existingOpen the account's open flags before this scan
 */
export function reconcileFlags(
  existingOpen: readonly Flag[],
  outcome: RuleOutcome,
  now: Date,
  newId: () => string = randomUUID
): FlagChanges {
  const drafts = new Map(outcome.drafts.map((draft) => [flagIdentity(draft.ruleId, draft.resourceKey), draft]))
  const open: Flag[] = []
  const raised: Flag[] = []
  const resolved: Flag[] = []
  const stillOpen = new Set<string>()

  for (const flag of existingOpen) {
    const identity = flagIdentity(flag.ruleId, flag.resourceKey)
    const draft = drafts.get(identity)
    if (draft) {
      open.push({ ...flag, severity: draft.severity, message: draft.message })
      stillOpen.add(identity)
    } else if (outcome.undecided.has(identity)) {
      open.push(flag)
      stillOpen.add(identity)
    } else {
      resolved.push({ ...flag, resolvedAt: now.toISOString() })
    }
  }

  for (const [identity, draft] of drafts) {
    if (stillOpen.has(identity)) continue
    const flag: Flag = {
      id: newId(),
      ruleId: draft.ruleId,
      resourceKey: draft.resourceKey,
      severity: draft.severity,
      message: draft.message,
      firstSeenAt: now.toISOString()
    }
    open.push(flag)
    raised.push(flag)
  }

  return { open, raised, resolved }
}

/** Reconciles the account's stored flags with this scan's rule outcome and saves the result. */
export function updateFlags(
  repo: Pick<Repo, 'listFlags' | 'upsertFlag'>,
  accountId: string,
  outcome: RuleOutcome,
  now: Date,
  newId: () => string = randomUUID
): FlagChanges {
  const changes = reconcileFlags(repo.listFlags(accountId), outcome, now, newId)
  const seenAt = now.toISOString()
  const matched = new Set(outcome.drafts.map((draft) => flagIdentity(draft.ruleId, draft.resourceKey)))

  for (const flag of changes.open) {
    // A flag the rules could not judge was not seen in this scan: it is not touched.
    if (matched.has(flagIdentity(flag.ruleId, flag.resourceKey))) repo.upsertFlag(accountId, flag, seenAt)
  }
  for (const flag of changes.resolved) repo.upsertFlag(accountId, flag, seenAt)
  return changes
}
