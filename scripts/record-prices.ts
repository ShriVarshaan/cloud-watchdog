// Records real AWS Price List responses, so the pricing engine's filters are
// taken from what AWS actually returns and not from memory. You run this by
// hand; automated tests never call AWS.
//
//   npm run record-prices -- --profile <name> [--regions us-east-1,eu-west-1]
//
// It makes read-only calls to the Price List Query API only:
//   pricing:GetProducts         (in iam/cloud-watchdog-readonly.json)
//   pricing:GetAttributeValues  (optional; skipped with a message when denied)
//
// The data is AWS's public price list. It contains nothing about your
// account, so there is nothing to sanitise.
//
// Output, all under tests/fixtures/_raw/pricing/ (ignored by git, because the
// broad queries here return far more than a test needs):
//   <query>.<region>.json   every product a query returned, parsed
//   summary.txt             per query: how many products, which attributes
//                           tell them apart, and the hourly/monthly prices
//
// The small fixtures the tests use are cut from these files afterwards.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  paginateGetAttributeValues,
  paginateGetProducts,
  PricingClient,
  type Filter
} from '@aws-sdk/client-pricing'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'

/** The Price List Query API exists only in us-east-1, eu-central-1 and ap-south-1. */
const PRICING_REGION = 'us-east-1'
const OUT_DIR = join('tests', 'fixtures', '_raw', 'pricing')
const DEFAULT_REGIONS = 'us-east-1,eu-west-1'
/** 100 products per page. Stops a query that is broader than expected. */
const MAX_PAGES = 40
/** Result sets up to this size are listed product by product in the summary. */
const LIST_UP_TO = 60
const MAX_VALUES_SHOWN = 15

const USAGE = `Usage: npm run record-prices -- --profile <name> [--regions ${DEFAULT_REGIONS}]

  --profile  AWS profile to call the Price List API with (required)
  --regions  comma-separated regions to record prices for; default: ${DEFAULT_REGIONS}`

interface Query {
  /** File name stem. */
  name: string
  serviceCode: string
  /** Attribute -> value, all TERM_MATCH. `regionCode` is added per region. */
  filters: Record<string, string>
  /** Tried, in order, when the query above returns nothing. */
  fallbacks?: Record<string, string>[]
}

// Deliberately broad: each one fixes only the attributes that identify the
// thing, so the result shows every other attribute that needs a filter.
const QUERIES: Query[] = [
  { name: 'ec2-t3-micro', serviceCode: 'AmazonEC2', filters: { instanceType: 't3.micro' } },
  { name: 'ec2-g4dn-xlarge', serviceCode: 'AmazonEC2', filters: { instanceType: 'g4dn.xlarge' } },
  { name: 'ebs-storage', serviceCode: 'AmazonEC2', filters: { productFamily: 'Storage' } },
  { name: 'ebs-iops', serviceCode: 'AmazonEC2', filters: { productFamily: 'System Operation' } },
  { name: 'ebs-throughput', serviceCode: 'AmazonEC2', filters: { productFamily: 'Provisioned Throughput' } },
  { name: 'nat-gateway', serviceCode: 'AmazonEC2', filters: { productFamily: 'NAT Gateway' } },
  { name: 'ec2-ip-address', serviceCode: 'AmazonEC2', filters: { productFamily: 'IP Address' } },
  { name: 'vpc-all', serviceCode: 'AmazonVPC', filters: {} },
  { name: 'rds-t3-micro', serviceCode: 'AmazonRDS', filters: { instanceType: 'db.t3.micro' } },
  { name: 'rds-t4g-micro', serviceCode: 'AmazonRDS', filters: { instanceType: 'db.t4g.micro' } },
  { name: 'rds-storage', serviceCode: 'AmazonRDS', filters: { productFamily: 'Database Storage' } },
  { name: 'elb-all', serviceCode: 'AWSELB', filters: {} },
  {
    name: 'sagemaker-ml-t2-medium',
    serviceCode: 'AmazonSageMaker',
    filters: { instanceName: 'ml.t2.medium' },
    fallbacks: [{ instanceType: 'ml.t2.medium' }, { productFamily: 'ML Instance' }]
  }
]

/** Lists the valid values of one attribute, to explain a query that returned nothing. */
const ATTRIBUTE_VALUES: { serviceCode: string; attribute: string }[] = [
  { serviceCode: 'AmazonEC2', attribute: 'productFamily' },
  { serviceCode: 'AmazonVPC', attribute: 'productFamily' },
  { serviceCode: 'AmazonRDS', attribute: 'productFamily' },
  { serviceCode: 'AmazonRDS', attribute: 'databaseEngine' },
  { serviceCode: 'AmazonRDS', attribute: 'deploymentOption' },
  { serviceCode: 'AWSELB', attribute: 'productFamily' },
  { serviceCode: 'AmazonSageMaker', attribute: 'productFamily' }
]

interface PriceDimension {
  unit?: string
  description?: string
  beginRange?: string
  endRange?: string
  pricePerUnit?: Record<string, string>
}
interface Product {
  product?: { sku?: string; productFamily?: string; attributes?: Record<string, string> }
  terms?: { OnDemand?: Record<string, { priceDimensions?: Record<string, PriceDimension> }> }
}

const toFilters = (attributes: Record<string, string>): Filter[] =>
  Object.entries(attributes).map(([Field, Value]) => ({ Type: 'TERM_MATCH', Field, Value }))

async function getProducts(
  client: PricingClient,
  serviceCode: string,
  attributes: Record<string, string>
): Promise<{ products: Product[]; truncated: boolean }> {
  const products: Product[] = []
  let pages = 0
  const input = { ServiceCode: serviceCode, Filters: toFilters(attributes), MaxResults: 100 }
  for await (const page of paginateGetProducts({ client }, input)) {
    // Each entry is one product as a JSON string.
    for (const item of page.PriceList ?? []) products.push(JSON.parse(String(item)) as Product)
    if (++pages >= MAX_PAGES) return { products, truncated: true }
  }
  return { products, truncated: false }
}

function onDemandDimensions(product: Product): PriceDimension[] {
  return Object.values(product.terms?.OnDemand ?? {}).flatMap((term) => Object.values(term.priceDimensions ?? {}))
}

function describePrice(product: Product): string {
  const dimensions = onDemandDimensions(product)
  if (dimensions.length === 0) return 'no on-demand price'
  return dimensions
    .map((d) => {
      const range = d.beginRange && d.beginRange !== '0' ? ` from ${d.beginRange}` : ''
      return `${d.pricePerUnit?.USD ?? '?'} USD per ${d.unit ?? '?'}${range}`
    })
    .join(' | ')
}

function summarise(title: string, products: Product[], truncated: boolean): string {
  const lines = [`=== ${title}`, `products: ${products.length}${truncated ? ` (stopped after ${MAX_PAGES} pages)` : ''}`]
  if (products.length === 0) return lines.join('\n') + '\n'

  // Which attributes differ between the products, and how.
  const values = new Map<string, Map<string, number>>()
  const count = (key: string, value: string) => {
    const seen = values.get(key) ?? new Map<string, number>()
    seen.set(value, (seen.get(value) ?? 0) + 1)
    values.set(key, seen)
  }
  for (const product of products) {
    count('productFamily', product.product?.productFamily ?? '(none)')
    for (const [key, value] of Object.entries(product.product?.attributes ?? {})) count(key, value)
    for (const dimension of onDemandDimensions(product)) count('(unit)', dimension.unit ?? '(none)')
  }
  lines.push('attributes (value x count):')
  for (const [key, seen] of [...values].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...seen].sort((a, b) => b[1] - a[1])
    const shown = sorted.slice(0, MAX_VALUES_SHOWN).map(([value, n]) => `${JSON.stringify(value)} x${n}`)
    const more = sorted.length > MAX_VALUES_SHOWN ? ` ... and ${sorted.length - MAX_VALUES_SHOWN} more` : ''
    lines.push(`  ${key}: ${shown.join(', ')}${more}`)
  }

  if (products.length <= LIST_UP_TO) {
    lines.push('each product:')
    for (const product of products) {
      const a = product.product?.attributes ?? {}
      lines.push(
        `  ${product.product?.sku} [${product.product?.productFamily ?? '-'}] usagetype=${a.usagetype ?? '-'} ` +
          `operation=${a.operation ?? '-'} -> ${describePrice(product)}`
      )
    }
  }
  return lines.join('\n') + '\n'
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { profile: { type: 'string' }, regions: { type: 'string' }, help: { type: 'boolean', short: 'h' } }
  })
  if (values.help || !values.profile) {
    console.log(USAGE)
    process.exitCode = values.help ? 0 : 1
    return
  }
  const regions = (values.regions ?? DEFAULT_REGIONS).split(',').map((region) => region.trim()).filter(Boolean)

  const client = new PricingClient({
    region: PRICING_REGION,
    credentials: fromNodeProviderChain({ profile: values.profile }),
    retryMode: 'adaptive',
    maxAttempts: 5
  })
  mkdirSync(OUT_DIR, { recursive: true })
  const summary: string[] = []
  let failures = 0

  for (const { serviceCode, attribute } of ATTRIBUTE_VALUES) {
    const title = `${serviceCode} values of "${attribute}"`
    try {
      const found: string[] = []
      const input = { ServiceCode: serviceCode, AttributeName: attribute }
      for await (const page of paginateGetAttributeValues({ client }, input)) {
        for (const value of page.AttributeValues ?? []) if (value.Value) found.push(value.Value)
      }
      summary.push(`=== ${title}\n${found.map((value) => `  ${JSON.stringify(value)}`).join('\n')}\n`)
      console.log(`${title}: ${found.length}`)
    } catch (error) {
      summary.push(`=== ${title}\nskipped: ${(error as Error).name}: ${(error as Error).message}\n`)
      console.error(`${title} skipped: ${(error as Error).name}`)
    }
  }

  for (const region of regions) {
    for (const query of QUERIES) {
      const attempts = [query.filters, ...(query.fallbacks ?? [])]
      for (const [index, attributes] of attempts.entries()) {
        const filters = { regionCode: region, ...attributes }
        const title = `${query.name}.${region}  ${query.serviceCode} ${JSON.stringify(filters)}`
        try {
          const { products, truncated } = await getProducts(client, query.serviceCode, filters)
          summary.push(summarise(title, products, truncated))
          console.log(`${query.name} in ${region}: ${products.length} product(s)${index > 0 ? ' (fallback filter)' : ''}`)
          if (products.length > 0) {
            const file = join(OUT_DIR, `${query.name}.${region}.json`)
            writeFileSync(file, JSON.stringify({ serviceCode: query.serviceCode, filters, products }, null, 2) + '\n')
            break
          }
        } catch (error) {
          failures++
          summary.push(`=== ${title}\nfailed: ${(error as Error).name}: ${(error as Error).message}\n`)
          console.error(`${query.name} in ${region} failed: ${(error as Error).name}: ${(error as Error).message}`)
          break
        }
      }
    }
  }

  const summaryFile = join(OUT_DIR, 'summary.txt')
  writeFileSync(summaryFile, summary.join('\n'))
  console.log(`\nWrote ${summaryFile} and one .json file per query that returned products.`)
  console.log(`Everything is in ${OUT_DIR}, which git ignores. Nothing here needs committing.`)
  if (failures > 0) {
    console.error(`${failures} query(ies) failed. Check that the profile allows pricing:GetProducts.`)
    process.exitCode = 1
  }
  client.destroy()
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error)
  process.exitCode = 1
})
