// One question to the AWS Price List: "what does one unit of this cost?"

/** The units the app knows how to turn into an hourly rate. */
export type PriceUnit = 'hour' | 'gb-month' | 'iops-month' | 'gibps-month'

export interface PriceQuery {
  /** Price List service code, e.g. 'AmazonEC2'. */
  serviceCode: string
  /**
   * Product attributes that must match exactly (TERM_MATCH), including
   * `regionCode`. Sent to AWS.
   */
  filters: Record<string, string>
  /**
   * The product's `usagetype` without its region prefix ("EU-", "USE1-").
   * Checked locally, because the prefix differs per region and the filters
   * alone often return several products (hours and bytes, in use and unused).
   */
  usageType: string
  /** The unit the price must be in. A price in any other unit is not a match. */
  unit: PriceUnit
}

/** Identifies a query in the price cache and the bundled snapshot. Filter order does not matter. */
export function priceQueryKey(query: PriceQuery): string {
  const filters = Object.entries(query.filters)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([field, value]) => `${field}=${value}`)
    .join('&')
  return `${query.serviceCode}|${filters}|${query.usageType}|${query.unit}`
}
