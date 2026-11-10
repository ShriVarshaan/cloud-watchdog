// The three numbers this app exists for: what is running costs per hour, how
// long the credits last, and what the plan is. The runway gauge is the one
// visual flourish in the app.

import { formatRunway, formatUsdPerHour, formatUsdPerMonth } from '../../shared/format'
import { planNotice } from '../../shared/plan'
import type { BurnRate, PlanState, Runway } from '../../shared/types'

/** The gauge is full at this many days or more. */
const GAUGE_DAYS = 90

export function BurnRateFigure({ burn }: { burn: BurnRate }) {
  const total = burn.exactUsdPerHour + burn.estimateUsdPerHour
  return (
    <div className="figure">
      <p className="figure-label" id="burn-label">
        Running now
      </p>
      <p className="figure-value" aria-describedby="burn-label">
        {formatUsdPerHour(burn.exactUsdPerHour)}
      </p>
      <p className="figure-note">
        {burn.estimateUsdPerHour > 0 && <>plus about {formatUsdPerHour(burn.estimateUsdPerHour)} estimated. </>}
        {burn.unknownCount > 0 && (
          <>
            {burn.unknownCount} {burn.unknownCount === 1 ? 'resource has' : 'resources have'} no price.{' '}
          </>
        )}
        {total > 0 ? `About ${formatUsdPerMonth(total)} if left running.` : 'Nothing that bills by the hour is running.'}
      </p>
    </div>
  )
}

export function RunwayGauge({ runway }: { runway: Runway | null }) {
  const days = runway?.days ?? null
  const fill = days === null ? null : Math.max(0, Math.min(1, days / GAUGE_DAYS))
  const level = days === null ? 'none' : days < 7 ? 'critical' : days < 14 ? 'warn' : 'ok'
  const text = formatRunway(runway)

  return (
    <div className="figure runway" data-level={level}>
      <p className="figure-label" id="runway-label">
        Credits last
      </p>
      <p className="figure-value">{runway ? text : 'Unknown'}</p>
      {fill !== null && (
        <div
          className="gauge"
          role="meter"
          aria-labelledby="runway-label"
          aria-valuemin={0}
          aria-valuemax={GAUGE_DAYS}
          aria-valuenow={Math.min(days!, GAUGE_DAYS)}
          aria-valuetext={text}
        >
          <div className="gauge-fill" style={{ inlineSize: `${fill * 100}%` }} />
        </div>
      )}
      <p className="figure-note">
        {runway === null
          ? 'The plan could not be read.'
          : runway.days === null
            ? 'No credits or end date to run out.'
            : runway.isUpperBound
              ? 'Some costs are not in the rate, so it may be sooner.'
              : runway.creditDays !== null && runway.days === runway.creditDays
                ? 'At the current rate.'
                : 'Until the plan ends.'}
      </p>
    </div>
  )
}

export function PlanFigure({ plan }: { plan: PlanState | null }) {
  const notice = planNotice(plan)
  return (
    <div className="figure">
      <p className="figure-label">Plan</p>
      <p className="figure-value">
        {plan === null ? 'Unknown' : `${plan.planType === 'FREE' ? 'Free' : 'Paid'}${plan.status === 'EXPIRED' ? ', ended' : ''}`}
      </p>
      <p className="figure-note">
        {plan?.remainingCreditsUsd != null && <>${plan.remainingCreditsUsd.toFixed(2)} credits left. </>}
        {plan?.expiresAt && <>Ends {new Date(plan.expiresAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}. </>}
        {plan !== null && notice && !notice.critical ? notice.text : null}
      </p>
    </div>
  )
}
