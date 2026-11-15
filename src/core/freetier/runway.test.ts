import { describe, expect, it } from 'vitest'
import type { BurnRate, PlanState, Price } from '../../shared/types'
import { computeRunway } from './runway'

const NOW = new Date('2026-11-10T12:00:00.000Z')

function plan(over: Partial<PlanState> = {}): PlanState {
  return {
    planType: 'FREE',
    status: 'ACTIVE',
    remainingCreditsUsd: 100,
    // 60 days after NOW
    expiresAt: '2027-01-09T12:00:00.000Z',
    fetchedAt: NOW.toISOString(),
    ...over
  }
}

const burn = (exactUsdPerHour: number, estimateUsdPerHour = 0, unknownCount = 0): BurnRate => ({
  exactUsdPerHour,
  estimateUsdPerHour,
  unknownCount
})

const exact = (hourlyUsd: number, excluded: string[] = []): Price => ({
  hourlyUsd,
  confidence: 'exact',
  source: 'price-list-api',
  excluded
})

describe('computeRunway', () => {
  it('divides the credits by the daily burn, exact and estimated together', () => {
    // (0.4 + 0.1) $/h x 24 = $12 a day; $100 lasts 8.33 days
    expect(computeRunway(plan(), burn(0.4, 0.1), [exact(0.4)], NOW)).toEqual({
      creditDays: 8.33,
      planDays: 60,
      days: 8.33,
      wholeDays: 8,
      isUpperBound: false
    })
  })

  it('takes the plan end date when it comes before the credits run out', () => {
    // $100 at $0.24 a day would last 416.67 days; the plan ends in 60
    expect(computeRunway(plan(), burn(0.01), [exact(0.01)], NOW)).toMatchObject({ creditDays: 416.67, planDays: 60, days: 60 })
  })

  it('has no credit limit when nothing is running: only the plan date counts', () => {
    expect(computeRunway(plan(), burn(0), [], NOW)).toEqual({ creditDays: null, planDays: 60, days: 60, wholeDays: 61, isUpperBound: false })
  })

  it('is zero days on the free plan once the credits are gone, even with nothing running', () => {
    expect(computeRunway(plan({ remainingCreditsUsd: 0 }), burn(0), [], NOW)).toMatchObject({ creditDays: 0, days: 0 })
  })

  it('uses the credits alone when AWS gives no end date', () => {
    expect(computeRunway(plan({ expiresAt: null }), burn(0.5), [exact(0.5)], NOW)).toEqual({
      creditDays: 8.33,
      planDays: null,
      days: 8.33,
      wholeDays: 8,
      isUpperBound: false
    })
  })

  it('uses the end date alone when AWS gives no credit figure', () => {
    expect(computeRunway(plan({ remainingCreditsUsd: null }), burn(0.5), [exact(0.5)], NOW)).toMatchObject({
      creditDays: null,
      planDays: 60,
      days: 60
    })
  })

  it('has no runway at all when there is neither a credit figure nor an end date', () => {
    expect(computeRunway(plan({ remainingCreditsUsd: null, expiresAt: null }), burn(0.5), [exact(0.5)], NOW)).toEqual({
      creditDays: null,
      planDays: null,
      days: null,
      wholeDays: null,
      isUpperBound: false
    })
  })

  it('counts part of a day to the plan end', () => {
    expect(computeRunway(plan({ expiresAt: '2026-11-11T00:00:00.000Z' }), burn(0), [], NOW)?.planDays).toBe(0.5)
  })

  it('is zero days when the end date has passed', () => {
    expect(computeRunway(plan({ expiresAt: '2026-11-01T00:00:00.000Z' }), burn(0.5), [exact(0.5)], NOW)).toMatchObject({
      planDays: 0,
      days: 0
    })
  })

  it('is zero days for an expired plan, whatever credits and date it still reports', () => {
    expect(computeRunway(plan({ status: 'EXPIRED' }), burn(0.01), [exact(0.01)], NOW)).toEqual({
      creditDays: null,
      planDays: 0,
      days: 0,
      wholeDays: 0,
      isUpperBound: false
    })
  })

  it('says "at most" when a resource has no price', () => {
    const unpriced: Price = { hourlyUsd: null, confidence: 'unknown', source: 'none', excluded: [] }
    expect(computeRunway(plan(), burn(0.5, 0, 1), [exact(0.5), unpriced], NOW)?.isUpperBound).toBe(true)
  })

  it('says "at most" when a priced resource also has usage charges the rate leaves out', () => {
    const nat = exact(0.048, ['Data processed, per GB'])
    expect(computeRunway(plan(), burn(0.048), [nat], NOW)?.isUpperBound).toBe(true)
  })

  it('says "at most" for the plan date too: unseen costs can still drain the credits first', () => {
    const unpriced: Price = { hourlyUsd: null, confidence: 'unknown', source: 'none', excluded: [] }
    expect(computeRunway(plan(), burn(0, 0, 1), [unpriced], NOW)).toEqual({
      creditDays: null,
      planDays: 60,
      days: 60,
      wholeDays: 61,
      isUpperBound: true
    })
  })

  it('does not say "at most" when there is no number to qualify', () => {
    const unpriced: Price = { hourlyUsd: null, confidence: 'unknown', source: 'none', excluded: [] }
    const runway = computeRunway(plan({ remainingCreditsUsd: null, expiresAt: null }), burn(0, 0, 1), [unpriced], NOW)
    expect(runway).toMatchObject({ days: null, isUpperBound: false })
  })

  it('gives a paid account with credits a runway for those credits', () => {
    const paid = plan({ planType: 'PAID', remainingCreditsUsd: 48, expiresAt: null })
    expect(computeRunway(paid, burn(0.5), [exact(0.5)], NOW)).toMatchObject({ creditDays: 4, planDays: null, days: 4 })
  })

  it('gives a paid account without credits no runway: it simply pays its bill', () => {
    const paid = plan({ planType: 'PAID', remainingCreditsUsd: 0, expiresAt: null })
    expect(computeRunway(paid, burn(0.5), [exact(0.5)], NOW)).toEqual({
      creditDays: null,
      planDays: null,
      days: null,
      wholeDays: null,
      isUpperBound: false
    })
  })

  it('has no runway when the plan is not known', () => {
    expect(computeRunway(null, burn(0.5), [exact(0.5)], NOW)).toBeNull()
  })

  describe('whole days, as the user reads them', () => {
    // Local dates, so the expectations hold in any time zone.
    const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min)

    it('counts the calendar days to the plan end, today and the last day included, as the AWS console does', () => {
      // Seen on a real account: 94.75 days left by the clock, 96 in the console.
      const now = at(2026, 11, 15, 18, 51)
      const runway = computeRunway(plan({ expiresAt: at(2027, 2, 18, 12, 52).toISOString() }), burn(0.0154), [exact(0.0154)], now)
      expect(runway).toMatchObject({ days: 94.75, wholeDays: 96 })
    })

    it('is one day on the last day of the plan', () => {
      const runway = computeRunway(plan({ expiresAt: at(2026, 11, 15, 20).toISOString() }), burn(0), [], at(2026, 11, 15, 9))
      expect(runway?.wholeDays).toBe(1)
    })

    it('does not count a last day that ends at its first moment', () => {
      // Ending at midnight means the plan is over when that day starts.
      const runway = computeRunway(plan({ expiresAt: at(2026, 11, 16).toISOString() }), burn(0), [], at(2026, 11, 15, 9))
      expect(runway?.wholeDays).toBe(1)
    })

    it('counts whole calendar days across a daylight saving change', () => {
      const runway = computeRunway(plan({ expiresAt: at(2027, 4, 10, 12).toISOString() }), burn(0), [], at(2027, 3, 1, 12))
      expect(runway?.wholeDays).toBe(41)
    })

    it('rounds down when the credits run out first: they can run out at any hour', () => {
      const runway = computeRunway(plan(), burn(0.4, 0.1), [exact(0.4)], NOW)
      expect(runway).toMatchObject({ days: 8.33, wholeDays: 8 })
    })

    it('is zero once the end date has passed', () => {
      const runway = computeRunway(plan({ expiresAt: '2026-11-01T00:00:00.000Z' }), burn(0), [], NOW)
      expect(runway).toMatchObject({ days: 0, wholeDays: 0 })
    })
  })
})
