import { GetProductsCommand, PricingClient } from '@aws-sdk/client-pricing'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, describe, expect, it } from 'vitest'
import { recordedPriceList, recordedProducts } from '../../../tests/fixtures/pricing'
import { createClientFactory, type ClientFactory } from '../aws/clients'
import { createPriceLookup, selectUnitPrice } from './priceListClient'
import type { PriceQuery } from './query'

const linuxT3Micro: PriceQuery = {
  serviceCode: 'AmazonEC2',
  filters: {
    regionCode: 'us-east-1',
    instanceType: 't3.micro',
    operation: 'RunInstances',
    tenancy: 'Shared',
    capacitystatus: 'Used'
  },
  usageType: 'BoxUsage:t3.micro',
  unit: 'hour'
}

const natGatewayIreland: PriceQuery = {
  serviceCode: 'AmazonEC2',
  filters: { regionCode: 'eu-west-1', productFamily: 'NAT Gateway', operation: 'NatGateway' },
  usageType: 'NatGateway-Hours',
  unit: 'hour'
}

const select = (query: PriceQuery) => selectUnitPrice(recordedProducts(query.serviceCode, query.filters), query)

describe('selectUnitPrice, on recorded AWS responses', () => {
  it('reads the hourly price and SKU of the one matching product', () => {
    expect(select(linuxT3Micro)).toEqual({ unitUsd: 0.0104, sku: 'CRAJUW7BTXFMT2UJ' })
  })

  it('picks the product by usage type when the filters return several, ignoring the region prefix', () => {
    // Four products come back: hours, bytes and two provisioned-bandwidth ones, all prefixed "EU-".
    expect(recordedProducts(natGatewayIreland.serviceCode, natGatewayIreland.filters)).toHaveLength(4)
    expect(select(natGatewayIreland)?.unitUsd).toBe(0.048)
  })

  it('does not mistake "TS-LoadBalancerUsage" or "Outposts-LoadBalancerUsage" for a region prefix', () => {
    const alb = (regionCode: string): PriceQuery => ({
      serviceCode: 'AWSELB',
      filters: { regionCode, productFamily: 'Load Balancer-Application' },
      usageType: 'LoadBalancerUsage',
      unit: 'hour'
    })
    expect(select(alb('us-east-1'))?.unitUsd).toBe(0.0225)
    expect(select(alb('eu-west-1'))?.unitUsd).toBe(0.0252)
  })

  it('tells a running database instance from an unused reservation of the same class', () => {
    const query: PriceQuery = {
      serviceCode: 'AmazonRDS',
      filters: {
        regionCode: 'us-east-1',
        productFamily: 'Database Instance',
        instanceType: 'db.t3.micro',
        databaseEngine: 'PostgreSQL',
        deploymentOption: 'Multi-AZ'
      },
      usageType: 'Multi-AZUsage:db.t3.micro',
      unit: 'hour'
    }
    expect(select(query)?.unitUsd).toBe(0.036)
  })

  it('accepts both spellings AWS uses for a GB-month', () => {
    const storage = (volumeApiName: string, usageType: string): PriceQuery => ({
      serviceCode: 'AmazonEC2',
      filters: { regionCode: 'us-east-1', productFamily: 'Storage', volumeApiName },
      usageType,
      unit: 'gb-month'
    })
    expect(select(storage('gp3', 'EBS:VolumeUsage.gp3'))?.unitUsd).toBe(0.08) // "GB-Mo"
    expect(select(storage('io2', 'EBS:VolumeUsage.io2'))?.unitUsd).toBe(0.125) // "GB-month"
  })

  it('finds nothing when the price is in a different unit than the query expects', () => {
    expect(select({ ...natGatewayIreland, usageType: 'NatGateway-Bytes' })).toBeNull()
  })

  it('finds nothing when no product has the usage type', () => {
    expect(select({ ...linuxT3Micro, usageType: 'BoxUsage:t3.small' })).toBeNull()
  })

  it('finds nothing in an empty response', () => {
    expect(selectUnitPrice([], linuxT3Micro)).toBeNull()
  })

  it('finds nothing when two products match, instead of guessing', () => {
    const [product] = recordedProducts(linuxT3Micro.serviceCode, linuxT3Micro.filters)
    const twin = { ...product!, product: { ...product!.product, sku: 'TWINTWINTWINTWIN' } }
    expect(selectUnitPrice([product, twin], linuxT3Micro)).toBeNull()
  })

  it('finds nothing when the product has more than one price, such as volume tiers', () => {
    const [product] = recordedProducts(linuxT3Micro.serviceCode, linuxT3Micro.filters)
    const term = Object.values(product!.terms.OnDemand)[0] as { priceDimensions: Record<string, object> }
    const dimension = Object.values(term.priceDimensions)[0]!
    const tiered = {
      ...product!,
      terms: { OnDemand: { t: { priceDimensions: { a: dimension, b: { ...dimension, beginRange: '750' } } } } }
    }
    expect(selectUnitPrice([tiered], linuxT3Micro)).toBeNull()
  })

  it.each([
    ['not an object', 'nonsense'],
    ['no terms', { product: { sku: 'X', attributes: { usagetype: 'BoxUsage:t3.micro' } } }],
    [
      'a price that is not a number',
      {
        product: { sku: 'X', attributes: { usagetype: 'BoxUsage:t3.micro' } },
        terms: { OnDemand: { t: { priceDimensions: { d: { unit: 'Hrs', pricePerUnit: { USD: 'free' } } } } } }
      }
    ],
    [
      'a price in another currency only',
      {
        product: { sku: 'X', attributes: { usagetype: 'BoxUsage:t3.micro' } },
        terms: { OnDemand: { t: { priceDimensions: { d: { unit: 'Hrs', pricePerUnit: { CNY: '0.1' } } } } } }
      }
    ]
  ])('finds nothing in a malformed product: %s', (_name, item) => {
    expect(selectUnitPrice([item], linuxT3Micro)).toBeNull()
  })
})

describe('createPriceLookup', () => {
  const pricing = mockClient(PricingClient)
  afterEach(() => pricing.reset())

  const real = createClientFactory({
    profile: 'hackathon',
    credentials: async () => ({ accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'fake' })
  })
  const regionsUsed: string[] = []
  const clients: ClientFactory = {
    profile: real.profile,
    get: (service, region) => {
      regionsUsed.push(region)
      return real.get(service, region)
    },
    destroy: () => real.destroy()
  }
  const signal = new AbortController().signal

  it('asks the us-east-1 endpoint, whatever region the price is for, with every filter as TERM_MATCH', async () => {
    pricing.on(GetProductsCommand).resolves({
      PriceList: recordedPriceList(natGatewayIreland.serviceCode, natGatewayIreland.filters)
    })

    expect(await createPriceLookup(clients)(natGatewayIreland, signal)).toEqual({ unitUsd: 0.048, sku: 'KFNSSCHWD43WZK2R' })
    expect(regionsUsed).toEqual(['us-east-1'])
    const input = pricing.commandCalls(GetProductsCommand)[0]!.args[0].input
    expect(input.ServiceCode).toBe('AmazonEC2')
    expect(input.Filters).toEqual([
      { Type: 'TERM_MATCH', Field: 'regionCode', Value: 'eu-west-1' },
      { Type: 'TERM_MATCH', Field: 'productFamily', Value: 'NAT Gateway' },
      { Type: 'TERM_MATCH', Field: 'operation', Value: 'NatGateway' }
    ])
  })

  it('looks through every page of the response', async () => {
    const [bytes, ...rest] = recordedPriceList(natGatewayIreland.serviceCode, natGatewayIreland.filters)
    pricing
      .on(GetProductsCommand)
      .resolves({ PriceList: [bytes!], NextToken: 'page-2' })
      .on(GetProductsCommand, { NextToken: 'page-2' })
      .resolves({ PriceList: rest })

    expect((await createPriceLookup(clients)(natGatewayIreland, signal))?.unitUsd).toBe(0.048)
    expect(pricing.commandCalls(GetProductsCommand)).toHaveLength(2)
  })

  it('returns null when AWS has no such product', async () => {
    pricing.on(GetProductsCommand).resolves({ PriceList: [] })
    expect(await createPriceLookup(clients)(linuxT3Micro, signal)).toBeNull()
  })

  it('lets an AWS error escape, so the caller can tell "denied" from "no such price"', async () => {
    const denied = Object.assign(new Error('not authorized to perform: pricing:GetProducts'), {
      name: 'AccessDeniedException'
    })
    pricing.on(GetProductsCommand).rejects(denied)
    await expect(createPriceLookup(clients)(linuxT3Micro, signal)).rejects.toThrow(/pricing:GetProducts/)
  })
})
