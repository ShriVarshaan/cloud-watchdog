// Rendered to HTML in plain Node: enough to check what text and labels the
// badges produce, without a browser.

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Price } from '../../shared/types'
import { CoverageBadge, PriceBadge } from './Badges'

const price = (hourlyUsd: number | null, confidence: Price['confidence']): Price => ({
  hourlyUsd,
  confidence,
  source: confidence === 'unknown' ? 'none' : 'price-list-api',
  excluded: []
})
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

describe('PriceBadge', () => {
  it('never renders a number for an unknown price', () => {
    const html = renderToStaticMarkup(<PriceBadge price={price(null, 'unknown')} />)
    expect(text(html)).toBe('— No price')
    expect(html).not.toMatch(/\d/)
  })

  it('shows an exact price with its label', () => {
    expect(text(renderToStaticMarkup(<PriceBadge price={price(0.048, 'exact')} />))).toBe('$0.048/h Exact')
  })

  it('marks an estimate as one, in words and not only by colour', () => {
    const html = renderToStaticMarkup(<PriceBadge price={price(0.02, 'estimate')} />)
    expect(text(html)).toBe('about $0.02/h Estimate')
    expect(html).toContain('data-confidence="estimate"')
  })

  it('shows a free resource as $0, exact', () => {
    expect(text(renderToStaticMarkup(<PriceBadge price={price(0, 'exact')} />))).toBe('$0/h Exact')
  })

  it('can leave the label out, keeping it for screen readers', () => {
    const html = renderToStaticMarkup(<PriceBadge price={price(0.048, 'exact')} compact />)
    expect(html).toContain('class="visually-hidden"')
  })
})

describe('CoverageBadge', () => {
  it.each([
    ['covered', 'Covered'],
    ['not-covered', 'You pay'],
    ['unknown', 'Unknown']
  ] as const)('%s reads "%s"', (coverage, label) => {
    expect(text(renderToStaticMarkup(<CoverageBadge coverage={coverage} />))).toBe(label)
  })
})
