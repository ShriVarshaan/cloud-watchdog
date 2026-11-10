// Messages above everything else: why scans are not working, and anything
// critical about the plan. They say what happened and what to do.

import { planNotice } from '../../shared/plan'
import type { AppState, PlanState } from '../../shared/types'

export function ProblemBanner({ problem }: { problem: AppState['problem'] }) {
  if (!problem) return null
  return (
    <div className="banner" data-tone="critical" role="alert">
      <p className="banner-title">{problem.code === 'auth-expired' ? 'Scans have stopped: the sign-in has expired' : 'The last scan could not run'}</p>
      <p>{problem.message}</p>
    </div>
  )
}

/** Shown when the plan is unavailable, expired, or the free-plan credits are gone. */
export function PlanBanner({ plan, scanned }: { plan: PlanState | null; scanned: boolean }) {
  if (!scanned) return null
  const notice = planNotice(plan)
  if (!notice || (plan !== null && !notice.critical)) return null
  return (
    <div className="banner" data-tone={notice.critical ? 'critical' : 'info'} role={notice.critical ? 'alert' : 'status'}>
      <p>{notice.text}</p>
      {plan === null && (
        <p>
          Costs are still shown, but not whether credits or the free tier pay for them. Allow freetier:GetAccountPlanState in
          the profile's IAM policy to see this.
        </p>
      )}
    </div>
  )
}
