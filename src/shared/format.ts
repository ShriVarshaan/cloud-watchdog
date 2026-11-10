// Money and time as the user reads them. Shared by the UI and the main
// process (toasts, tray tooltip), so both say the same thing.

import type { Price, Runway } from './types'

/** AWS's month for hourly prices: 8760 hours / 12. */
const HOURS_PER_MONTH = 730

export function formatUsdPerHour(usd: number): string {
  if (usd === 0) return '$0/h'
  if (usd < 0.001) return '<$0.001/h'
  // Three decimals below 10 cents, so $0.048 does not read as $0.05; a trailing zero is dropped.
  if (usd < 0.1) return `$${usd.toFixed(3).replace(/0$/, '')}/h`
  return `$${usd.toFixed(2)}/h`
}

/** An hourly rate as a month of it. */
export function formatUsdPerMonth(usdPerHour: number): string {
  const month = usdPerHour * HOURS_PER_MONTH
  if (month === 0) return '$0/month'
  if (month < 0.1) return 'under $0.10/month'
  if (month < 100) return `$${month.toFixed(2)}/month`
  return `$${Math.round(month)}/month`
}

/** A resource's rate. An unknown price is never shown as a number. */
export function formatPrice(price: Price): string {
  if (price.hourlyUsd === null) return '—'
  if (price.confidence !== 'estimate') return formatUsdPerHour(price.hourlyUsd)
  // "about <$0.001/h" reads badly.
  return price.hourlyUsd > 0 && price.hourlyUsd < 0.001 ? 'under $0.001/h' : `about ${formatUsdPerHour(price.hourlyUsd)}`
}

export function formatRunway(runway: Runway | null): string {
  if (!runway) return 'Plan unknown'
  if (runway.days === null) return 'No limit'
  if (runway.days <= 0) return 'Ended'
  if (runway.days < 1) return 'Less than a day'
  const whole = Math.floor(runway.days)
  const text = `${whole} ${whole === 1 ? 'day' : 'days'}`
  return runway.isUpperBound ? `At most ${text}` : text
}

export function formatAgo(iso: string, now: Date): string {
  const seconds = Math.max(0, (now.getTime() - Date.parse(iso)) / 1000)
  if (seconds < 60) return 'just now'
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'} ago`
  if (seconds < 3600) return unit(Math.floor(seconds / 60), 'minute')
  if (seconds < 86_400) return unit(Math.floor(seconds / 3600), 'hour')
  return unit(Math.floor(seconds / 86_400), 'day')
}
