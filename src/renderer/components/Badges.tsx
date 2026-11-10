// Small labels for price confidence, coverage and severity. Each one says
// its meaning in words; colour only repeats it.

import { formatPrice } from '../../shared/format'
import type { Coverage, Price, Severity } from '../../shared/types'

const CONFIDENCE_LABEL: Record<Price['confidence'], string> = {
  exact: 'Exact',
  estimate: 'Estimate',
  unknown: 'No price'
}

export const CONFIDENCE_EXPLANATION: Record<Price['confidence'], string> = {
  exact: 'From the AWS price list for this exact configuration.',
  estimate: 'Worked out from a monthly price, a stored copy of the price list, or the on-demand price as a ceiling.',
  unknown: 'This app could not find a single price for it, so it shows none rather than a guess.'
}

export function PriceBadge({ price, compact = false }: { price: Price; compact?: boolean }) {
  return (
    <span className="price" data-confidence={price.confidence}>
      <span className="price-value">{formatPrice(price)}</span>{' '}
      <span className={compact ? 'visually-hidden' : 'price-label'}>{CONFIDENCE_LABEL[price.confidence]}</span>
    </span>
  )
}

const COVERAGE_LABEL: Record<Coverage, string> = {
  covered: 'Covered',
  'not-covered': 'You pay',
  unknown: 'Unknown'
}

export function CoverageBadge({ coverage }: { coverage: Coverage }) {
  return (
    <span className="coverage" data-coverage={coverage}>
      {COVERAGE_LABEL[coverage]}
    </span>
  )
}

export const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Critical', warn: 'Warning', info: 'Note' }

export function SeverityMark({ severity }: { severity: Severity }) {
  return (
    <span className="severity" data-severity={severity}>
      {SEVERITY_LABEL[severity]}
    </span>
  )
}
