// Asks the AWS Price List Query API (pricing:GetProducts) for one unit price.
//
// The rule that keeps prices honest lives in `selectUnitPrice`: a price is
// returned only when exactly one product matches and that product has exactly
// one on-demand price, in the expected unit, in USD. Anything else (nothing
// found, two candidates, volume tiers, an unexpected unit) returns null, and
// the pricing engine shows the resource as unpriced instead of guessing.
//
// The shapes read here were taken from recorded responses
// (tests/fixtures/pricing/recorded.json), not from documentation.

import { paginateGetProducts, PricingClient } from '@aws-sdk/client-pricing'
import type { ClientFactory } from '../aws/clients'
import type { PriceQuery, PriceUnit } from './query'

/** The Price List Query API exists in us-east-1, eu-central-1 and ap-south-1 only. */
export const PRICE_LIST_REGION = 'us-east-1'

export interface UnitPrice {
  /** USD for one unit (one hour, one GB-month, ...) as the query's `unit` says. */
  unitUsd: number
  sku: string | null
}

/** Resolves to null when AWS has no single matching price. Rejects when the call itself fails. */
export type PriceLookup = (query: PriceQuery, signal: AbortSignal) => Promise<UnitPrice | null>

/** The unit strings AWS uses, lower-cased. EBS io2 storage says "GB-month" where the rest say "GB-Mo". */
const UNIT_NAMES: Record<string, PriceUnit> = {
  hrs: 'hour',
  'gb-mo': 'gb-month',
  'gb-month': 'gb-month',
  'iops-mo': 'iops-month',
  'gibps-mo': 'gibps-month'
}

/**
 * Usage types carry a region prefix everywhere but us-east-1: "USE2-",
 * "APS1-", and plain "EU-" for eu-west-1. It must not swallow real prefixes
 * such as "TS-" (ALB trust stores) or "Outposts-".
 */
const REGION_PREFIX = /^(?:[A-Z]{3,4}\d|EU)-/

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'

function usageTypeOf(product: unknown): string | null {
  if (!isRecord(product) || !isRecord(product.product) || !isRecord(product.product.attributes)) return null
  const usageType = product.product.attributes.usagetype
  return typeof usageType === 'string' ? usageType.replace(REGION_PREFIX, '') : null
}

/** The product's single on-demand price in `unit`, or null when there is not exactly one. */
function onDemandUsd(product: Record<string, unknown>, unit: PriceUnit): number | null {
  if (!isRecord(product.terms) || !isRecord(product.terms.OnDemand)) return null
  const terms = Object.values(product.terms.OnDemand)
  if (terms.length !== 1 || !isRecord(terms[0]) || !isRecord(terms[0].priceDimensions)) return null
  const dimensions = Object.values(terms[0].priceDimensions)
  if (dimensions.length !== 1) return null

  const dimension = dimensions[0]
  if (!isRecord(dimension) || typeof dimension.unit !== 'string' || !isRecord(dimension.pricePerUnit)) return null
  if (UNIT_NAMES[dimension.unit.toLowerCase()] !== unit) return null
  const text = dimension.pricePerUnit.USD
  if (typeof text !== 'string' || text.trim() === '') return null
  const usd = Number(text)
  return Number.isFinite(usd) && usd >= 0 ? usd : null
}

/** Picks the unit price for `query` out of the products AWS returned for its filters. */
export function selectUnitPrice(products: readonly unknown[], query: PriceQuery): UnitPrice | null {
  const matching = products.filter((product) => usageTypeOf(product) === query.usageType)
  if (matching.length !== 1) return null

  const product = matching[0] as { product: { sku?: unknown } } & Record<string, unknown>
  const unitUsd = onDemandUsd(product, query.unit)
  if (unitUsd === null) return null
  return { unitUsd, sku: typeof product.product.sku === 'string' ? product.product.sku : null }
}

function parse(item: unknown): unknown {
  // Each PriceList entry is one product as a JSON string.
  try {
    return JSON.parse(String(item))
  } catch {
    return null
  }
}

export function createPriceLookup(clients: ClientFactory): PriceLookup {
  return async (query, signal) => {
    const client = clients.get(PricingClient, PRICE_LIST_REGION)
    const input = {
      ServiceCode: query.serviceCode,
      Filters: Object.entries(query.filters).map(([Field, Value]) => ({ Type: 'TERM_MATCH' as const, Field, Value })),
      MaxResults: 100
    }
    const products: unknown[] = []
    for await (const page of paginateGetProducts({ client }, input, { abortSignal: signal })) {
      for (const item of page.PriceList ?? []) products.push(parse(item))
    }
    return selectUnitPrice(products, query)
  }
}
