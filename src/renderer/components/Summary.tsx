// The three numbers this app exists for: what is running costs per hour, how
// long the credits last, and what the plan is. The runway ring is the one
// bold visual in the app (docs/DESIGN.md); in the popover it is the hero.

import { formatRunway, formatUsdPerHour, formatUsdPerMonth } from '../../shared/format'
import { planNotice } from '../../shared/plan'
import type { BurnRate, PlanState, Runway } from '../../shared/types'

/** The ring is full at this many days or more. */
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

/** What the hero ring shows inside: a short number and its unit. The meter's text says the whole thing. */
function ringText(runway: Runway): { prefix: string | null; number: string; unit: string } {
  const days = runway.days ?? 0
  const prefix = runway.isUpperBound ? 'at most' : null
  if (days <= 0) return { prefix: null, number: '0', unit: 'days left' }
  if (days < 1) return { prefix, number: '<1', unit: 'day' }
  const whole = Math.floor(days)
  return { prefix, number: String(whole), unit: whole === 1 ? 'day' : 'days' }
}

export function RunwayGauge({ runway, hero = false }: { runway: Runway | null; hero?: boolean }) {
  const days = runway?.days ?? null
  const fill = days === null ? null : Math.max(0, Math.min(1, days / GAUGE_DAYS))
  const level = days === null ? 'none' : days < 7 ? 'critical' : days < 14 ? 'warn' : 'ok'
  const text = formatRunway(runway)
  const inside = hero && runway && fill !== null ? ringText(runway) : null

  return (
    <div className="figure runway" data-level={level} data-hero={hero || undefined}>
      {fill !== null && (
        <div
          className="ring"
          role="meter"
          aria-labelledby="runway-label"
          aria-valuemin={0}
          aria-valuemax={GAUGE_DAYS}
          aria-valuenow={Math.min(days!, GAUGE_DAYS)}
          aria-valuetext={text}
        >
          <svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">
            <circle className="ring-track" cx="20" cy="20" r="17" pathLength={100} />
            {/* A sliver stays visible at zero, so an ended runway still reads as a ring. */}
            <circle className="ring-fill" cx="20" cy="20" r="17" pathLength={100} strokeDasharray={`${Math.max(fill * 100, 1)} 100`} />
          </svg>
          {inside && (
            <span className="ring-text" aria-hidden="true">
              {inside.prefix && <span className="ring-prefix">{inside.prefix}</span>}
              <span className="ring-number">{inside.number}</span>
              <span className="ring-unit">{inside.unit}</span>
            </span>
          )}
        </div>
      )}
      <div className="figure-text">
        <p className="figure-label" id="runway-label">
          Credits last
        </p>
        {!inside && <p className="figure-value">{runway ? text : 'Unknown'}</p>}
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
