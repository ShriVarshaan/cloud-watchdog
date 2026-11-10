import { describe, expect, it } from 'vitest'
import { formatAgo, formatPrice, formatRunway, formatUsdPerHour, formatUsdPerMonth } from './format'

describe('formatUsdPerHour', () => {
  it.each([
    [0, '$0/h'],
    [0.0004, '<$0.001/h'],
    [0.0114, '$0.011/h'],
    [0.048, '$0.048/h'],
    [0.05, '$0.05/h'],
    [0.42, '$0.42/h'],
    [1.5, '$1.50/h'],
    [12.3456, '$12.35/h']
  ])('%s -> %s', (usd, text) => {
    expect(formatUsdPerHour(usd)).toBe(text)
  })
})

describe('formatUsdPerMonth', () => {
  it.each([
    [0, '$0/month'],
    [0.0001, 'under $0.10/month'],
    [0.0114, '$8.32/month'],
    [0.6564, '$479/month']
  ])('%s per hour -> %s', (usd, text) => {
    expect(formatUsdPerMonth(usd)).toBe(text)
  })
})

describe('formatPrice', () => {
  it('never shows a number for an unknown price', () => {
    expect(formatPrice({ hourlyUsd: null, confidence: 'unknown', source: 'none', excluded: [] })).toBe('—')
  })

  it('marks an estimate', () => {
    expect(formatPrice({ hourlyUsd: 0.02, confidence: 'estimate', source: 'bundled', excluded: [] })).toBe('about $0.02/h')
  })

  it('shows an exact price plainly', () => {
    expect(formatPrice({ hourlyUsd: 0.048, confidence: 'exact', source: 'price-list-api', excluded: [] })).toBe('$0.048/h')
  })
})

describe('formatRunway', () => {
  const runway = (days: number | null, isUpperBound = false) => ({ creditDays: days, planDays: null, days, isUpperBound })

  it.each([
    [null, 'Plan unknown'],
    [runway(null), 'No limit'],
    [runway(0), 'Ended'],
    [runway(0.4), 'Less than a day'],
    [runway(1.2), '1 day'],
    [runway(13.9), '13 days'],
    [runway(13.9, true), 'At most 13 days']
  ])('%j -> %s', (value, text) => {
    expect(formatRunway(value)).toBe(text)
  })
})

describe('formatAgo', () => {
  const now = new Date('2026-11-10T12:00:00.000Z')
  it.each([
    ['2026-11-10T11:59:40.000Z', 'just now'],
    ['2026-11-10T11:59:00.000Z', '1 minute ago'],
    ['2026-11-10T11:15:00.000Z', '45 minutes ago'],
    ['2026-11-10T10:00:00.000Z', '2 hours ago'],
    ['2026-11-08T12:00:00.000Z', '2 days ago']
  ])('%s -> %s', (iso, text) => {
    expect(formatAgo(iso, now)).toBe(text)
  })
})
