import { beforeEach, describe, expect, it } from 'vitest'
import { recordedProducts } from '../../../tests/fixtures/pricing'
import type { AttrValue, Price, Resource, ResourceKind } from '../../shared/types'
import { openDb } from '../store/db'
import { migrate } from '../store/migrations'
import { createRepo, type Repo } from '../store/repo'
import { createPricingEngine } from './engine'
import { selectUnitPrice, type PriceLookup, type UnitPrice } from './priceListClient'
import { priceQueryKey, type PriceQuery } from './query'

const ACCOUNT = '111122223333'
const NOW = new Date('2026-11-10T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
const signal = new AbortController().signal

let nextId = 0
function make(kind: ResourceKind, region: string, state: string, attrs: Record<string, AttrValue>): Resource {
  const id = `r-${++nextId}`
  return { key: `${ACCOUNT}:${kind}:${region}:${id}`, kind, region, id, state, attrs }
}

const ec2 = (region: string, state: string, over: Record<string, AttrValue> = {}) =>
  make('ec2-instance', region, state, {
    instanceType: 't3.micro',
    platformDetails: 'Linux/UNIX',
    usageOperation: 'RunInstances',
    tenancy: 'default',
    lifecycle: 'on-demand',
    publicIp: null,
    rootDeviceType: 'ebs',
    autoScalingGroup: null,
    ...over
  })
const ebs = (region: string, over: Record<string, AttrValue>) =>
  make('ebs-volume', region, 'available', { iops: null, throughputMibps: null, attachedInstanceId: null, attachmentCount: 0, ...over })
const eip = (region: string, state: string) =>
  make('elastic-ip', region, state, { publicIp: '203.0.113.9', associatedInstanceId: null, networkInterfaceId: null, publicIpv4Pool: 'amazon' })
const nat = (region: string) => make('nat-gateway', region, 'available', { connectivityType: 'public', availabilityMode: 'zonal' })
const rds = (region: string, state: string, over: Record<string, AttrValue> = {}) =>
  make('rds-instance', region, state, {
    instanceClass: 'db.t3.micro',
    engine: 'mysql',
    licenseModel: 'general-public-license',
    multiAz: false,
    storageType: 'gp3',
    allocatedStorageGb: 20,
    iops: null,
    clusterId: null,
    replicaSourceId: null,
    replicaCount: 0,
    publiclyAccessible: false,
    ...over
  })
const alb = (region: string) => make('load-balancer', region, 'active', { type: 'application', scheme: 'internal', ipAddressType: 'ipv4', zoneCount: 2 })
const endpoint = (region: string, instanceCount: number) =>
  make('sagemaker-endpoint', region, 'in-service', {
    variants: JSON.stringify([{ name: 'AllTraffic', instanceType: 'ml.t2.medium', instanceCount, serverless: false, shadow: false }]),
    instanceCount,
    serverless: false
  })

/** Answers from the recorded AWS responses, and counts the calls. */
function recordedLookup() {
  const calls: PriceQuery[] = []
  const lookup: PriceLookup = async (query) => {
    calls.push(query)
    return selectUnitPrice(recordedProducts(query.serviceCode, query.filters), query)
  }
  return { lookup, calls }
}

function denied(): Error {
  return Object.assign(new Error('User is not authorized to perform: pricing:GetProducts'), { name: 'AccessDeniedException' })
}

let repo: Repo
beforeEach(() => {
  const db = openDb(':memory:')
  migrate(db)
  repo = createRepo(db)
})

function engine(lookup: PriceLookup, bundled: Record<string, number> = {}, now: Date = NOW) {
  return createPricingEngine({ lookup, cache: repo, bundled, now: () => now })
}

async function priceOf(resource: Resource, others: Resource[] = []): Promise<Price> {
  const { resources } = await engine(recordedLookup().lookup).price([resource, ...others], signal)
  return resources[0]!.price
}

describe('pricing each kind from recorded AWS prices', () => {
  // Expected rates are worked out by hand from the recording (tests/fixtures/pricing/recorded.json).
  it.each<[string, () => Resource, number, Price['confidence']]>([
    ['a Linux t3.micro in eu-west-1', () => ec2('eu-west-1', 'running'), 0.0114, 'exact'],
    ['a Windows t3.micro in us-east-1', () => ec2('us-east-1', 'running', { usageOperation: 'RunInstances:0002' }), 0.0196, 'exact'],
    // 0.0114 + 0.005 for the auto-assigned public IPv4 address
    ['a t3.micro with a public address', () => ec2('eu-west-1', 'running', { publicIp: '198.51.100.7' }), 0.0164, 'exact'],
    ['a g4dn.xlarge GPU instance', () => ec2('eu-west-1', 'running', { instanceType: 'g4dn.xlarge' }), 0.587, 'exact'],
    ['a spot instance, at the on-demand ceiling', () => ec2('eu-west-1', 'running', { lifecycle: 'spot' }), 0.0114, 'estimate'],
    // 8 GB x $0.088 per GB-month / 730 hours
    ['an 8 GB gp3 volume', () => ebs('eu-west-1', { volumeType: 'gp3', sizeGb: 8, iops: 3000, throughputMibps: 125 }), 0.00096438, 'estimate'],
    // (100 x 0.08 + 1000 x 0.005 + 0.25 x 40.96) / 730 = 23.24 / 730
    [
      'a gp3 volume with extra IOPS and throughput',
      () => ebs('us-east-1', { volumeType: 'gp3', sizeGb: 100, iops: 4000, throughputMibps: 381 }),
      0.03183562,
      'estimate'
    ],
    // (50 x 0.125 + 2000 x 0.065) / 730 = 136.25 / 730
    ['an io1 volume', () => ebs('us-east-1', { volumeType: 'io1', sizeGb: 50, iops: 2000 }), 0.18664384, 'estimate'],
    ['an idle Elastic IP', () => eip('eu-west-1', 'unassociated'), 0.005, 'exact'],
    ['an Elastic IP in use', () => eip('us-east-1', 'associated'), 0.005, 'exact'],
    ['a NAT gateway in eu-west-1', () => nat('eu-west-1'), 0.048, 'exact'],
    ['a NAT gateway in us-east-1', () => nat('us-east-1'), 0.045, 'exact'],
    // 0.017 + 20 GB x 0.115 / 730
    ['a MySQL db.t3.micro with 20 GB gp3', () => rds('us-east-1', 'available'), 0.02015068, 'estimate'],
    // 0.039 + 20 GB x 0.254 / 730
    [
      'a Multi-AZ PostgreSQL db.t3.micro',
      () => rds('eu-west-1', 'available', { engine: 'postgres', multiAz: true }),
      0.04595890,
      'estimate'
    ],
    // storage only: 20 GB x 0.115 / 730
    ['a stopped MySQL instance', () => rds('us-east-1', 'stopped'), 0.00315068, 'estimate'],
    ['an Application Load Balancer', () => alb('us-east-1'), 0.0225, 'exact'],
    ['a SageMaker endpoint with two ml.t2.medium', () => endpoint('eu-west-1', 2), 0.12, 'exact']
  ])('%s', async (_name, build, hourlyUsd, confidence) => {
    const price = await priceOf(build())
    expect(price.hourlyUsd).toBe(hourlyUsd)
    expect(price.confidence).toBe(confidence)
    expect(price.source).toBe('price-list-api')
  })

  it('prices a stopped EC2 instance at exactly zero without asking AWS', async () => {
    const { lookup, calls } = recordedLookup()
    const { resources } = await engine(lookup).price([ec2('eu-west-1', 'stopped')], signal)
    expect(resources[0]!.price).toEqual({ hourlyUsd: 0, confidence: 'exact', source: 'none', excluded: [] })
    expect(calls).toHaveLength(0)
  })

  it('does not add the address charge to an instance whose address is an Elastic IP in the same scan', async () => {
    const instance = ec2('eu-west-1', 'running', { publicIp: '203.0.113.9' })
    expect((await priceOf(instance, [eip('eu-west-1', 'associated')])).hourlyUsd).toBe(0.0114)
  })

  it('shows no number when AWS has no single price for the resource', async () => {
    // t3.small is not in the recording: the lookup finds nothing.
    const price = await priceOf(ec2('eu-west-1', 'running', { instanceType: 't3.small' }))
    expect(price).toEqual({
      hourlyUsd: null,
      confidence: 'unknown',
      source: 'none',
      excluded: ['Data transfer', 'CPU credits above the baseline (unlimited mode)']
    })
  })

  it('shows no number when one part of the rate is missing, even if the other parts are known', async () => {
    // The storage price exists; the db.m5.large instance price is not in the recording.
    const price = await priceOf(rds('us-east-1', 'available', { instanceClass: 'db.m5.large' }))
    expect(price.hourlyUsd).toBeNull()
    expect(price.confidence).toBe('unknown')
  })

  it('shows no number, and asks AWS nothing, for a resource the app cannot price', async () => {
    const { lookup, calls } = recordedLookup()
    const { resources } = await engine(lookup).price([ec2('eu-west-1', 'running', { tenancy: 'host' })], signal)
    expect(resources[0]!.price).toMatchObject({ hourlyUsd: null, confidence: 'unknown', source: 'none' })
    expect(calls).toHaveLength(0)
  })

  it('passes on the usage charges the rate leaves out', async () => {
    expect((await priceOf(nat('eu-west-1'))).excluded).toEqual(['Data processed, per GB', 'Data transfer'])
  })

  it('keeps every other field of the resource, in the same order', async () => {
    const input = [{ ...nat('eu-west-1'), stale: true }, { ...eip('eu-west-1', 'unassociated'), stale: false }]
    const { resources } = await engine(recordedLookup().lookup).price(input, signal)
    expect(resources.map(({ price: _price, ...rest }) => rest)).toEqual(input)
  })
})

describe('the price cache', () => {
  const natQuery: PriceQuery = {
    serviceCode: 'AmazonEC2',
    filters: { regionCode: 'eu-west-1', productFamily: 'NAT Gateway', operation: 'NatGateway' },
    usageType: 'NatGateway-Hours',
    unit: 'hour'
  }
  const KEY = priceQueryKey(natQuery)
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

  it('asks AWS once for resources that share a price', async () => {
    const { lookup, calls } = recordedLookup()
    const { resources } = await engine(lookup).price([nat('eu-west-1'), nat('eu-west-1'), nat('eu-west-1')], signal)
    expect(calls).toHaveLength(1)
    expect(resources.map((r) => r.price.hourlyUsd)).toEqual([0.048, 0.048, 0.048])
  })

  it('stores a fetched price with the time it was fetched', async () => {
    await engine(recordedLookup().lookup).price([nat('eu-west-1')], signal)
    expect(repo.getCachedPrice(KEY)).toEqual({ unitUsd: 0.048, sku: 'KFNSSCHWD43WZK2R', fetchedAt: NOW.toISOString() })
  })

  it('uses a cached price younger than 7 days without asking AWS, and still calls it exact', async () => {
    repo.putCachedPrice(KEY, { unitUsd: 0.05, sku: 'CACHED' }, ago(7 * DAY_MS - 1000))
    const { lookup, calls } = recordedLookup()
    const { resources } = await engine(lookup).price([nat('eu-west-1')], signal)

    expect(calls).toHaveLength(0)
    expect(resources[0]!.price).toMatchObject({ hourlyUsd: 0.05, confidence: 'exact', source: 'price-list-api' })
  })

  it('fetches again once the cached price is 7 days old, and replaces it', async () => {
    repo.putCachedPrice(KEY, { unitUsd: 0.05, sku: 'CACHED' }, ago(7 * DAY_MS))
    const { lookup, calls } = recordedLookup()
    const { resources } = await engine(lookup).price([nat('eu-west-1')], signal)

    expect(calls).toHaveLength(1)
    expect(resources[0]!.price.hourlyUsd).toBe(0.048)
    expect(repo.getCachedPrice(KEY)?.unitUsd).toBe(0.048)
  })

  it('does not store "no price found"', async () => {
    await engine(async () => null).price([nat('eu-west-1')], signal)
    expect(repo.getCachedPrice(KEY)).toBeNull()
  })
})

describe('when the Price List cannot be reached', () => {
  const natKey = priceQueryKey({
    serviceCode: 'AmazonEC2',
    filters: { regionCode: 'eu-west-1', productFamily: 'NAT Gateway', operation: 'NatGateway' },
    usageType: 'NatGateway-Hours',
    unit: 'hour'
  })
  function failing(error: Error) {
    let calls = 0
    const lookup: PriceLookup = async () => {
      calls++
      throw error
    }
    return { lookup, calls: () => calls }
  }

  it('falls back to the bundled snapshot, labelled as an estimate', async () => {
    const { resources } = await engine(failing(denied()).lookup, { [natKey]: 0.048 }).price([nat('eu-west-1')], signal)
    expect(resources[0]!.price).toMatchObject({ hourlyUsd: 0.048, confidence: 'estimate', source: 'bundled' })
  })

  it('uses the snapshot shipped with the app when none is passed in', async () => {
    const shipped = createPricingEngine({ lookup: failing(denied()).lookup, cache: repo, now: () => NOW })
    const { resources } = await shipped.price([nat('eu-west-1'), ec2('ap-south-1', 'running')], signal)
    expect(resources[0]!.price).toMatchObject({ hourlyUsd: 0.048, confidence: 'estimate', source: 'bundled' })
    // The snapshot covers two regions only; anything else stays unpriced.
    expect(resources[1]!.price.confidence).toBe('unknown')
  })

  it('shows no number when the snapshot has no entry either', async () => {
    const { resources } = await engine(failing(denied()).lookup).price([nat('eu-west-1')], signal)
    expect(resources[0]!.price).toMatchObject({ hourlyUsd: null, confidence: 'unknown', source: 'none' })
  })

  it('prefers an expired cached price over the snapshot, as an estimate', async () => {
    repo.putCachedPrice(natKey, { unitUsd: 0.05, sku: 'OLD' }, new Date(NOW.getTime() - 30 * DAY_MS).toISOString())
    const { resources } = await engine(failing(denied()).lookup, { [natKey]: 0.048 }).price([nat('eu-west-1')], signal)
    expect(resources[0]!.price).toMatchObject({ hourlyUsd: 0.05, confidence: 'estimate', source: 'price-list-api' })
  })

  it('reports the failure once and stops asking for the rest of the scan', async () => {
    const { lookup, calls } = failing(denied())
    const input = [nat('eu-west-1'), nat('us-east-1'), alb('us-east-1'), eip('eu-west-1', 'unassociated')]
    const { resources, errors } = await engine(lookup).price(input, signal)

    expect(calls()).toBe(1)
    expect(errors).toEqual([
      { scanner: 'pricing', region: null, code: 'access-denied', message: 'User is not authorized to perform: pricing:GetProducts' }
    ])
    expect(resources.map((r) => r.price.confidence)).toEqual(['unknown', 'unknown', 'unknown', 'unknown'])
  })

  it('still uses fresh cached prices after the failure', async () => {
    const albKey = priceQueryKey({
      serviceCode: 'AWSELB',
      filters: { regionCode: 'us-east-1', productFamily: 'Load Balancer-Application' },
      usageType: 'LoadBalancerUsage',
      unit: 'hour'
    })
    repo.putCachedPrice(albKey, { unitUsd: 0.0225, sku: 'ALB' }, NOW.toISOString())
    const { resources } = await engine(failing(denied()).lookup).price([nat('eu-west-1'), alb('us-east-1')], signal)
    expect(resources[1]!.price).toMatchObject({ hourlyUsd: 0.0225, confidence: 'exact' })
  })

  it('does not treat "AWS has no such price" as a failure: no error, no snapshot, and it keeps asking', async () => {
    const calls: string[] = []
    const lookup: PriceLookup = async (query) => {
      calls.push(query.usageType)
      return query.usageType === 'NatGateway-Hours' ? null : { unitUsd: 0.0225, sku: null }
    }
    const { resources, errors } = await engine(lookup, { [natKey]: 0.048 }).price([nat('eu-west-1'), alb('us-east-1')], signal)

    expect(errors).toEqual([])
    expect(calls).toEqual(['NatGateway-Hours', 'LoadBalancerUsage'])
    expect(resources[0]!.price).toMatchObject({ hourlyUsd: null, confidence: 'unknown', source: 'none' })
    expect(resources[1]!.price).toMatchObject({ hourlyUsd: 0.0225, confidence: 'exact' })
  })

  it('reports no error when every lookup works', async () => {
    const { errors } = await engine(recordedLookup().lookup).price([nat('eu-west-1')], signal)
    expect(errors).toEqual([])
  })

  it('rejects, instead of reporting an error, when the scan was cancelled', async () => {
    const controller = new AbortController()
    const lookup: PriceLookup = async () => {
      controller.abort()
      throw Object.assign(new Error('Request aborted'), { name: 'AbortError' })
    }
    await expect(engine(lookup).price([nat('eu-west-1')], controller.signal)).rejects.toThrow('Request aborted')
  })
})

describe('burn rate', () => {
  it('adds exact and estimated rates separately and counts the unpriced', async () => {
    const input = [
      ec2('eu-west-1', 'running'), // 0.0114 exact
      nat('eu-west-1'), // 0.048 exact
      ec2('eu-west-1', 'stopped'), // 0 exact
      rds('us-east-1', 'available'), // 0.02015068 estimate
      rds('us-east-1', 'stopped'), // 0.00315068 estimate
      ec2('eu-west-1', 'running', { tenancy: 'host' }), // unknown
      ec2('eu-west-1', 'running', { instanceType: 't3.small' }) // unknown
    ]
    const { burn } = await engine(recordedLookup().lookup).price(input, signal)
    expect(burn).toEqual({ exactUsdPerHour: 0.0594, estimateUsdPerHour: 0.02330136, unknownCount: 2 })
  })

  it('is zero for an empty account', async () => {
    const { burn } = await engine(recordedLookup().lookup).price([], signal)
    expect(burn).toEqual({ exactUsdPerHour: 0, estimateUsdPerHour: 0, unknownCount: 0 })
  })

  it('counts resources carried forward from an earlier scan', async () => {
    const { burn } = await engine(recordedLookup().lookup).price([{ ...nat('eu-west-1'), stale: true }], signal)
    expect(burn.exactUsdPerHour).toBe(0.048)
  })
})

describe('the confidence invariant', () => {
  // A small deterministic generator, so a failure can be reproduced.
  function random(seed: number) {
    let state = seed
    return () => {
      state = (state * 1664525 + 1013904223) % 4294967296
      return state / 4294967296
    }
  }

  it('has no number if and only if the confidence is unknown, whatever the resources and whatever AWS answers', async () => {
    const next = random(20261110)
    const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!
    const regions = ['eu-west-1', 'us-east-1', 'ap-south-1']

    const builders: (() => Resource)[] = [
      () =>
        ec2(pick(regions), pick(['running', 'stopped', 'pending']), {
          instanceType: pick(['t3.micro', 'g4dn.xlarge', 't3.small', null]),
          usageOperation: pick(['RunInstances', 'RunInstances:0002', null]),
          tenancy: pick(['default', 'dedicated', 'host', null]),
          lifecycle: pick(['on-demand', 'spot', 'scheduled']),
          publicIp: pick(['198.51.100.7', null])
        }),
      () =>
        ebs(pick(regions), {
          volumeType: pick(['gp2', 'gp3', 'io1', 'io2', 'st1', 'sc1', 'standard', 'gp9', null]),
          sizeGb: pick([8, 100, 0, null]),
          iops: pick([3000, 16000, 64000, null]),
          throughputMibps: pick([125, 500, null])
        }),
      () => eip(pick(regions), pick(['associated', 'unassociated'])),
      () => make('nat-gateway', pick(regions), 'available', { connectivityType: 'public', availabilityMode: pick(['zonal', 'regional']) }),
      () =>
        rds(pick(regions), pick(['available', 'stopped', 'modifying']), {
          instanceClass: pick(['db.t3.micro', 'db.t4g.micro', 'db.m5.large', null]),
          engine: pick(['mysql', 'postgres', 'mariadb', 'aurora-mysql', 'sqlserver-ex', null]),
          multiAz: pick([true, false, null]),
          storageType: pick(['gp2', 'gp3', 'io1', 'aurora', null]),
          allocatedStorageGb: pick([20, null])
        }),
      () => make('load-balancer', pick(regions), 'active', { type: pick(['application', 'network', 'gateway', 'classic', null]), scheme: null }),
      () => endpoint(pick(regions), pick([0, 1, 3]))
    ]

    for (let round = 0; round < 40; round++) {
      // AWS answers with a price, with nothing, or (rarely) with an error.
      const lookup: PriceLookup = async (query): Promise<UnitPrice | null> => {
        const roll = next()
        if (roll < 0.05) throw denied()
        if (roll < 0.3) return null
        return selectUnitPrice(recordedProducts(query.serviceCode, query.filters), query) ?? { unitUsd: next(), sku: null }
      }
      const bundled = next() < 0.5 ? { [priceQueryKey({ serviceCode: 'AmazonVPC', filters: { regionCode: 'eu-west-1', group: 'VPCPublicIPv4Address' }, usageType: 'PublicIPv4:IdleAddress', unit: 'hour' })]: 0.005 } : {}
      const input = Array.from({ length: 25 }, () => pick(builders)())
      const { resources, burn } = await engine(lookup, bundled).price(input, signal)

      for (const { price } of resources) {
        expect(price.hourlyUsd === null).toBe(price.confidence === 'unknown')
        if (price.hourlyUsd !== null) expect(price.hourlyUsd).toBeGreaterThanOrEqual(0)
        if (price.hourlyUsd === null) expect(price.source).toBe('none')
      }
      expect(burn.unknownCount).toBe(resources.filter((r) => r.price.confidence === 'unknown').length)
    }
  })
})
