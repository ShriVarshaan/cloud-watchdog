// The pricing engine: resource -> hourly USD with an honest confidence label.
//
//   exact     every part of the rate is an hourly on-demand price that the
//             Price List API returned as a single match (now, or cached
//             within the last 7 days), and nothing was assumed
//   estimate  a real number with a caveat: a monthly price divided by 730
//             hours, a spot instance at the on-demand ceiling, or a price
//             from the bundled snapshot or an expired cache entry because
//             the Price List could not be reached
//   unknown   no number at all (hourlyUsd is null, shown as "—"): the
//             resource cannot be priced (see priceKeys.ts), AWS returned no
//             single match, or the Price List failed and nothing older exists
//
// A rate is all-or-nothing. If one part of it is missing the whole resource
// is unknown; a partial sum is never shown.
//
// Where a unit price comes from, in order:
//   1. the cache, if fetched less than 7 days ago
//   2. the Price List API (the answer is then cached)
//   3. only if that call fails: the expired cache entry, then the bundled
//      snapshot. After one failure the API is not asked again in this pass.
//
// The engine never throws for a pricing problem. It reports one ScanError
// and degrades. It rejects only when the scan was cancelled.

import type { BurnRate, Price, Resource, ScanError } from '../../shared/types'
import { classifyAwsError } from '../aws/errors'
import type { Repo } from '../store/repo'
import bundledSnapshot from './bundledPrices.json' with { type: 'json' }
import { planContext, pricePlan, type PricePlan } from './priceKeys'
import type { PriceLookup } from './priceListClient'
import { priceQueryKey, type PriceQuery, type PriceUnit } from './query'

export const PRICE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** AWS bills a month as 730 hours (8760 / 12) when it quotes monthly prices by the hour. */
export const HOURS_PER_MONTH = 730

/** Units per hour for one unit of each kind of price. */
const PER_HOUR: Record<PriceUnit, number> = {
  hour: 1,
  'gb-month': 1 / HOURS_PER_MONTH,
  'iops-month': 1 / HOURS_PER_MONTH,
  'gibps-month': 1 / HOURS_PER_MONTH
}

/** Rates are kept to 8 decimal places: far below a cent a year, and free of floating-point noise. */
const round = (usd: number) => Math.round(usd * 1e8) / 1e8

export interface PricingEngineOptions {
  lookup: PriceLookup
  cache: Pick<Repo, 'getCachedPrice' | 'putCachedPrice'>
  /** Price key -> unit price, used only when the Price List cannot be reached. Defaults to bundledPrices.json. */
  bundled?: Readonly<Record<string, number>>
  now?: () => Date
}

export interface PricingResult<T extends Resource> {
  /** The input resources, in the same order, each with its price. */
  resources: (T & { price: Price })[]
  /** At most one: why the Price List could not be used. */
  errors: ScanError[]
  burn: BurnRate
}

export interface PricingEngine {
  price<T extends Resource>(resources: readonly T[], signal: AbortSignal): Promise<PricingResult<T>>
}

/** A unit price and how far it can be trusted. `null` = there is none. */
type Resolved = { unitUsd: number; origin: 'api' | 'expired-cache' | 'bundled' } | null

export function burnRate(prices: readonly Price[]): BurnRate {
  let exact = 0
  let estimate = 0
  let unknownCount = 0
  for (const price of prices) {
    if (price.hourlyUsd === null) unknownCount++
    else if (price.confidence === 'exact') exact += price.hourlyUsd
    else estimate += price.hourlyUsd
  }
  return { exactUsdPerHour: round(exact), estimateUsdPerHour: round(estimate), unknownCount }
}

export function createPricingEngine(options: PricingEngineOptions): PricingEngine {
  const { lookup, cache } = options
  const bundled: Readonly<Record<string, number>> = options.bundled ?? bundledSnapshot.prices
  const now = options.now ?? (() => new Date())

  return {
    async price<T extends Resource>(resources: readonly T[], signal: AbortSignal): Promise<PricingResult<T>> {
      const errors: ScanError[] = []
      /** One answer per distinct query in this pass, so shared prices are fetched once. */
      const resolved = new Map<string, Resolved>()
      let priceListFailed = false

      async function resolve(query: PriceQuery): Promise<Resolved> {
        const key = priceQueryKey(query)
        const known = resolved.get(key)
        if (known !== undefined) return known

        const answer = await fetchOrFallBack(query, key)
        resolved.set(key, answer)
        return answer
      }

      async function fetchOrFallBack(query: PriceQuery, key: string): Promise<Resolved> {
        const cached = cache.getCachedPrice(key)
        if (cached && now().getTime() - Date.parse(cached.fetchedAt) < PRICE_CACHE_TTL_MS) {
          return { unitUsd: cached.unitUsd, origin: 'api' }
        }

        if (!priceListFailed) {
          try {
            const found = await lookup(query, signal)
            // AWS answered: there is no single price. Older data must not paper over that.
            if (!found) return null
            cache.putCachedPrice(key, found, now().toISOString())
            return { unitUsd: found.unitUsd, origin: 'api' }
          } catch (error) {
            if (signal.aborted) throw error
            priceListFailed = true
            errors.push({ scanner: 'pricing', region: null, ...classifyAwsError(error) })
          }
        }

        if (cached) return { unitUsd: cached.unitUsd, origin: 'expired-cache' }
        const snapshot = bundled[key]
        return typeof snapshot === 'number' ? { unitUsd: snapshot, origin: 'bundled' } : null
      }

      async function priceFor(plan: PricePlan): Promise<Price> {
        const unknown: Price = { hourlyUsd: null, confidence: 'unknown', source: 'none', excluded: plan.excluded }
        if (plan.unknown !== undefined) return unknown
        if (plan.components.length === 0) return { hourlyUsd: 0, confidence: 'exact', source: 'none', excluded: plan.excluded }

        let hourlyUsd = 0
        let exact = !plan.upperBound
        let usedSnapshot = false
        for (const { query, quantity } of plan.components) {
          const unit = await resolve(query)
          if (!unit) return unknown
          hourlyUsd += quantity * unit.unitUsd * PER_HOUR[query.unit]
          if (unit.origin !== 'api' || query.unit !== 'hour') exact = false
          if (unit.origin === 'bundled') usedSnapshot = true
        }
        return {
          hourlyUsd: round(hourlyUsd),
          confidence: exact ? 'exact' : 'estimate',
          source: usedSnapshot ? 'bundled' : 'price-list-api',
          excluded: plan.excluded
        }
      }

      const context = planContext(resources)
      const priced: (T & { price: Price })[] = []
      // One after another: a scan has a handful of distinct prices, and most come from the cache.
      for (const resource of resources) {
        priced.push({ ...resource, price: await priceFor(pricePlan(resource, context)) })
      }

      return { resources: priced, errors, burn: burnRate(priced.map((resource) => resource.price)) }
    }
  }
}
