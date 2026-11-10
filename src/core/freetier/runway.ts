// How long until the credits or the plan run out, in days.
//
//   creditDays  remaining credits / what is running costs per day
//   planDays    time until the end date AWS reports
//   days        the smaller of the two that exist
//
// The end date always comes from AWS (GetAccountPlanState). It is never
// worked out here, because AWS's own pages disagree on how long credits last.
//
// The burn rate only knows hourly rates. Costs it cannot see (an unpriced
// resource, data transfer, capacity units) drain credits too, so when any
// exist the result is an upper bound and the UI says "at most N days".

import type { BurnRate, PlanState, Price, Runway } from '../../shared/types'

const DAY_MS = 24 * 60 * 60 * 1000
const round = (days: number) => Math.round(days * 100) / 100

function creditDays(plan: PlanState, burn: BurnRate): number | null {
  const credits = plan.remainingCreditsUsd
  if (credits === null) return null
  if (credits <= 0) {
    // On the free plan the account closes when credits reach zero. A paid
    // account without credits has nothing to run out of: it pays its bill.
    return plan.planType === 'FREE' ? 0 : null
  }
  // Exact and estimated rates are both real money, so both count here.
  const usdPerDay = (burn.exactUsdPerHour + burn.estimateUsdPerHour) * 24
  // Nothing running that the app can price: credits are not being used up.
  if (usdPerDay <= 0) return null
  return round(credits / usdPerDay)
}

/**
 * @param prices the price of every resource in the scan, to see whether any cost is not in the burn rate
 * @returns null when the plan is not known
 */
export function computeRunway(plan: PlanState | null, burn: BurnRate, prices: readonly Price[], now: Date): Runway | null {
  if (!plan) return null
  if (plan.status === 'EXPIRED') return { creditDays: null, planDays: 0, days: 0, isUpperBound: false }

  const byCredits = creditDays(plan, burn)
  const byDate = plan.expiresAt === null ? null : Math.max(0, round((Date.parse(plan.expiresAt) - now.getTime()) / DAY_MS))
  const limits = [byCredits, byDate].filter((limit): limit is number => limit !== null)
  const days = limits.length > 0 ? Math.min(...limits) : null

  const unseenCosts = burn.unknownCount > 0 || prices.some((price) => price.excluded.length > 0)
  return { creditDays: byCredits, planDays: byDate, days, isUpperBound: days !== null && unseenCosts }
}
