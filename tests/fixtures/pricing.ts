// Real Price List products, cut from a recording made with
// `npm run record-prices` on 2026-11-10 (us-east-1 and eu-west-1). They are
// AWS's public prices and contain nothing about an account. The only change
// from what AWS returned: `terms.Reserved` is removed, because it is large
// and the app reads on-demand prices only.
//
// The recording used broad queries. `recordedProducts` narrows it the way the
// API's TERM_MATCH filter does: an attribute must equal the value exactly.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

interface RecordedProduct {
  product: { sku: string; productFamily?: string; attributes: Record<string, string> }
  serviceCode: string
  terms: { OnDemand: Record<string, unknown> }
}

const ALL = JSON.parse(
  readFileSync(fileURLToPath(new URL('./pricing/recorded.json', import.meta.url)), 'utf8')
) as RecordedProduct[]

/** The products GetProducts would return for these filters, as parsed objects. */
export function recordedProducts(serviceCode: string, filters: Record<string, string>): RecordedProduct[] {
  return ALL.filter(
    (item) =>
      item.serviceCode === serviceCode &&
      Object.entries(filters).every(([field, value]) =>
        field === 'productFamily' ? item.product.productFamily === value : item.product.attributes[field] === value
      )
  )
}

/** The same, as the JSON strings the SDK puts in `PriceList`. */
export function recordedPriceList(serviceCode: string, filters: Record<string, string>): string[] {
  return recordedProducts(serviceCode, filters).map((item) => JSON.stringify(item))
}
