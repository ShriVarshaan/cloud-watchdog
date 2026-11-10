// The one message about the account plan as a whole, shared by the core
// (coverage messages) and the UI (the banner above the resource list).

import type { PlanState } from './types'

export const PLAN_UNAVAILABLE = 'Plan details unavailable for this account. Showing resources only.'
export const CREDITS_FREE_PLAN = 'Paid from credits. The account closes when they run out.'
export const CREDITS_PAID_PLAN = 'Paid from credits. You are charged once they run out.'

/** The one message about the account as a whole, for the popover and the banner. null = nothing to say. */
export function planNotice(plan: PlanState | null): { text: string; critical: boolean } | null {
  if (!plan) return { text: PLAN_UNAVAILABLE, critical: false }
  if (plan.status === 'EXPIRED') {
    return { text: 'The account plan has expired. Nothing running is paid for by credits or the free plan any more.', critical: true }
  }
  const credits = plan.remainingCreditsUsd
  if (credits !== null && credits > 0) {
    return { text: plan.planType === 'FREE' ? CREDITS_FREE_PLAN : CREDITS_PAID_PLAN, critical: false }
  }
  if (plan.planType === 'FREE' && credits !== null) {
    return { text: 'The free plan credits are used up. AWS closes the account unless it is upgraded.', critical: true }
  }
  return null
}
