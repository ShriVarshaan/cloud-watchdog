// Turns a resource into a price plan: the Price List queries whose answers,
// multiplied and added up, give its hourly rate.
//
// This file decides WHAT to look up; it never calls AWS and holds no prices.
// Every filter value and usage type below was read from a recording of real
// GetProducts responses (`npm run record-prices`), not written from memory.
//
// Two rules:
//   - Every attribute a query uses must come from the describe call. If one
//     is missing or has a value this file does not know, the plan is
//     `unknown` with a reason. It never falls back to a "typical" value.
//   - Charges that depend on usage (data processed, capacity units, data
//     transfer) are never estimated. They are named in `excluded`.

import type { Resource } from '../../shared/types'
import type { PriceQuery } from './query'

export interface PriceComponent {
  query: PriceQuery
  /** How many units: 1 instance, 30 GB, 1000 IOPS, 2 endpoint instances. */
  quantity: number
}

export interface PricePlan {
  /** Added together. Empty with no `unknown` means the resource costs nothing right now. */
  components: PriceComponent[]
  /** Usage charges the rate does not include, in plain words. */
  excluded: string[]
  /** Set when no honest rate can be given. Says why. The components are then not used. */
  unknown?: string
  /** true when the real rate can only be lower (a spot instance priced on-demand). */
  upperBound?: boolean
}

export interface PlanContext {
  /** `${region}|${publicIp}` of every Elastic IP in the scan. Each is priced as its own resource. */
  elasticIps: ReadonlySet<string>
}

export function planContext(resources: readonly Resource[]): PlanContext {
  const elasticIps = new Set<string>()
  for (const resource of resources) {
    const ip = resource.attrs.publicIp
    if (resource.kind === 'elastic-ip' && typeof ip === 'string') elasticIps.add(`${resource.region}|${ip}`)
  }
  return { elasticIps }
}

const unknown = (reason: string, excluded: string[] = []): PricePlan => ({ components: [], excluded, unknown: reason })

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)
const amount = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null)

const DATA_TRANSFER = 'Data transfer'
const DATA_PROCESSED = 'Data processed, per GB'

function publicIpv4(region: string, inUse: boolean): PriceQuery {
  return {
    serviceCode: 'AmazonVPC',
    filters: { regionCode: region, group: 'VPCPublicIPv4Address' },
    usageType: inUse ? 'PublicIPv4:InUseAddress' : 'PublicIPv4:IdleAddress',
    unit: 'hour'
  }
}

// ---------------------------------------------------------------------------
// EC2 instances
// ---------------------------------------------------------------------------

/** Placement.Tenancy -> the Price List's tenancy value and usage type. Dedicated Hosts bill per host, not per instance. */
const EC2_TENANCY: Record<string, { tenancy: string; usage: string }> = {
  default: { tenancy: 'Shared', usage: 'BoxUsage' },
  dedicated: { tenancy: 'Dedicated', usage: 'DedicatedUsage' }
}

/** t2, t3, t3a, t4g: burstable types that can bill for extra CPU credits. */
const BURSTABLE = /^(?:db\.)?t\d/

function ec2Instance(resource: Resource, ctx: PlanContext): PricePlan {
  // Only a running instance bills for compute. Its volumes and any Elastic IP
  // are resources of their own and stay priced while it is stopped.
  if (resource.state !== 'running') return { components: [], excluded: [] }

  const { attrs, region } = resource
  const instanceType = text(attrs.instanceType)
  const operation = text(attrs.usageOperation)
  const tenancy = text(attrs.tenancy)
  if (!instanceType) return unknown('AWS did not report the instance type.')
  if (!operation) return unknown('AWS did not report the billing operation (operating system).')
  if (!tenancy) return unknown('AWS did not report the tenancy.')
  if (tenancy === 'host') return unknown('Runs on a Dedicated Host, which is billed per host, not per instance.')
  const mapped = EC2_TENANCY[tenancy]
  if (!mapped) return unknown(`Unknown tenancy "${tenancy}".`)

  const lifecycle = text(attrs.lifecycle)
  if (lifecycle !== 'on-demand' && lifecycle !== 'spot') return unknown(`Unknown purchase option "${lifecycle ?? ''}".`)

  const components: PriceComponent[] = [
    {
      // The instance's UsageOperation is the Price List's `operation`: it
      // encodes the operating system, any bundled SQL Server, and the licence.
      query: {
        serviceCode: 'AmazonEC2',
        filters: { regionCode: region, instanceType, operation, tenancy: mapped.tenancy, capacitystatus: 'Used' },
        usageType: `${mapped.usage}:${instanceType}`,
        unit: 'hour'
      },
      quantity: 1
    }
  ]

  // An auto-assigned public address bills like an Elastic IP in use.
  const publicIp = text(attrs.publicIp)
  if (publicIp && !ctx.elasticIps.has(`${region}|${publicIp}`)) {
    components.push({ query: publicIpv4(region, true), quantity: 1 })
  }

  const excluded = [DATA_TRANSFER]
  if (BURSTABLE.test(instanceType)) excluded.push('CPU credits above the baseline (unlimited mode)')
  if (tenancy === 'dedicated') excluded.push('Dedicated instance fee per region')

  return { components, excluded, ...(lifecycle === 'spot' ? { upperBound: true } : {}) }
}

// ---------------------------------------------------------------------------
// EBS volumes
// ---------------------------------------------------------------------------

/** VolumeType -> usage type of its storage price. */
const EBS_STORAGE_USAGE: Record<string, string> = {
  gp2: 'EBS:VolumeUsage.gp2',
  gp3: 'EBS:VolumeUsage.gp3',
  io1: 'EBS:VolumeUsage.piops',
  io2: 'EBS:VolumeUsage.io2',
  st1: 'EBS:VolumeUsage.st1',
  sc1: 'EBS:VolumeUsage.sc1',
  standard: 'EBS:VolumeUsage'
}

// Included in the gp3 storage price (AWS documentation, "Amazon EBS General Purpose SSD volumes").
const GP3_FREE_IOPS = 3000
const GP3_FREE_THROUGHPUT_MIBPS = 125
/** io2 IOPS above this are billed in cheaper tiers, which one price cannot express. */
const IO2_FIRST_TIER_IOPS = 32_000
const MIB_PER_GIB = 1024

function ebsVolume(resource: Resource): PricePlan {
  const { attrs, region } = resource
  const volumeType = text(attrs.volumeType)
  const sizeGb = amount(attrs.sizeGb)
  if (!volumeType) return unknown('AWS did not report the volume type.')
  const storageUsage = EBS_STORAGE_USAGE[volumeType]
  if (!storageUsage) return unknown(`Unknown volume type "${volumeType}".`)
  if (sizeGb === null) return unknown('AWS did not report the volume size.')

  const part = (productFamily: string, usageType: string, unit: PriceQuery['unit'], quantity: number): PriceComponent => ({
    query: {
      serviceCode: 'AmazonEC2',
      filters: { regionCode: region, productFamily, volumeApiName: volumeType },
      usageType,
      unit
    },
    quantity
  })

  // A volume bills for its size whether attached or not.
  const components = [part('Storage', storageUsage, 'gb-month', sizeGb)]
  const iops = amount(attrs.iops)

  if (volumeType === 'gp3') {
    const throughput = amount(attrs.throughputMibps)
    if (iops === null) return unknown('AWS did not report the provisioned IOPS.')
    if (throughput === null) return unknown('AWS did not report the provisioned throughput.')
    if (iops > GP3_FREE_IOPS) {
      components.push(part('System Operation', 'EBS:VolumeP-IOPS.gp3', 'iops-month', iops - GP3_FREE_IOPS))
    }
    if (throughput > GP3_FREE_THROUGHPUT_MIBPS) {
      const extraGibps = (throughput - GP3_FREE_THROUGHPUT_MIBPS) / MIB_PER_GIB
      components.push(part('Provisioned Throughput', 'EBS:VolumeP-Throughput.gp3', 'gibps-month', extraGibps))
    }
  } else if (volumeType === 'io1' || volumeType === 'io2') {
    if (iops === null) return unknown('AWS did not report the provisioned IOPS.')
    if (volumeType === 'io2' && iops > IO2_FIRST_TIER_IOPS) {
      return unknown(`io2 volumes above ${IO2_FIRST_TIER_IOPS} IOPS are billed in tiers the app does not model.`)
    }
    const usage = volumeType === 'io1' ? 'EBS:VolumeP-IOPS.piops' : 'EBS:VolumeP-IOPS.io2'
    if (iops > 0) components.push(part('System Operation', usage, 'iops-month', iops))
  }

  return { components, excluded: volumeType === 'standard' ? ['I/O requests'] : [] }
}

// ---------------------------------------------------------------------------
// Elastic IPs
// ---------------------------------------------------------------------------

function elasticIp(resource: Resource): PricePlan {
  // 'amazon' is Amazon's own pool. Addresses the account brought itself (BYOIP) follow other rules.
  const pool = text(resource.attrs.publicIpv4Pool)
  if (pool !== null && pool !== 'amazon') return unknown('The address is from a pool the account brought itself (BYOIP).')
  return { components: [{ query: publicIpv4(resource.region, resource.state === 'associated'), quantity: 1 }], excluded: [] }
}

// ---------------------------------------------------------------------------
// NAT gateways
// ---------------------------------------------------------------------------

function natGateway(resource: Resource): PricePlan {
  const excluded = [DATA_PROCESSED, DATA_TRANSFER]
  if (resource.attrs.availabilityMode !== 'zonal') {
    return unknown('A regional NAT gateway is billed per zone it is active in, which the scan does not see.', excluded)
  }
  // The scanner drops deleted and failed gateways; every state left (pending, available, deleting) is priced.
  return {
    components: [
      {
        query: {
          serviceCode: 'AmazonEC2',
          filters: { regionCode: resource.region, productFamily: 'NAT Gateway', operation: 'NatGateway' },
          usageType: 'NatGateway-Hours',
          unit: 'hour'
        },
        quantity: 1
      }
    ],
    excluded
  }
}

// ---------------------------------------------------------------------------
// RDS instances
// ---------------------------------------------------------------------------

/**
 * DescribeDBInstances `Engine` -> the Price List's `databaseEngine`. Only the
 * engines with recorded prices. SQL Server, Oracle and Db2 also need an
 * edition and a licence model; Aurora bills storage on the cluster.
 */
const RDS_ENGINE: Record<string, string> = { mysql: 'MySQL', postgres: 'PostgreSQL', mariadb: 'MariaDB' }

/** StorageType -> the end of the storage usage type. */
const RDS_STORAGE_USAGE: Record<string, string> = {
  gp2: 'GP2-Storage',
  gp3: 'GP3-Storage',
  io1: 'PIOPS-Storage',
  io2: 'PIOPS-Storage-IO2',
  standard: 'StorageUsage'
}

function rdsInstance(resource: Resource): PricePlan {
  const { attrs, region } = resource
  const instanceClass = text(attrs.instanceClass)
  const engine = text(attrs.engine)
  if (!instanceClass) return unknown('AWS did not report the instance class.')
  if (!engine) return unknown('AWS did not report the database engine.')
  if (text(attrs.clusterId)) {
    return unknown('Belongs to a database cluster (Aurora or Multi-AZ DB cluster), which the app does not price yet.')
  }
  const databaseEngine = RDS_ENGINE[engine]
  if (!databaseEngine) return unknown(`The app has no prices for the "${engine}" engine yet.`)
  if (typeof attrs.multiAz !== 'boolean') return unknown('AWS did not report whether the instance is Multi-AZ.')
  const multiAz = attrs.multiAz

  const storageType = text(attrs.storageType)
  const storageUsage = storageType ? RDS_STORAGE_USAGE[storageType] : undefined
  if (!storageType || !storageUsage) return unknown(`Unknown storage type "${storageType ?? ''}".`)
  const sizeGb = amount(attrs.allocatedStorageGb)
  if (sizeGb === null) return unknown('AWS did not report the storage size.')

  const deploymentOption = multiAz ? 'Multi-AZ' : 'Single-AZ'
  const components: PriceComponent[] = []

  // A stopped instance bills for storage only. Every other state keeps billing for the instance.
  if (resource.state !== 'stopped') {
    components.push({
      query: {
        serviceCode: 'AmazonRDS',
        filters: { regionCode: region, productFamily: 'Database Instance', instanceType: instanceClass, databaseEngine, deploymentOption },
        usageType: `${multiAz ? 'Multi-AZUsage' : 'InstanceUsage'}:${instanceClass}`,
        unit: 'hour'
      },
      quantity: 1
    })
  }
  components.push({
    query: {
      serviceCode: 'AmazonRDS',
      filters: { regionCode: region, productFamily: 'Database Storage', databaseEngine, deploymentOption },
      usageType: `RDS:${multiAz ? 'Multi-AZ-' : ''}${storageUsage}`,
      unit: 'gb-month'
    },
    quantity: sizeGb
  })

  const excluded = ['Backup storage beyond the free allowance', DATA_TRANSFER]
  if (storageType === 'io1' || storageType === 'io2') excluded.push('Provisioned IOPS')
  if (storageType === 'gp3' && amount(attrs.iops) !== null) excluded.push('Provisioned IOPS and throughput above the gp3 baseline')
  if (BURSTABLE.test(instanceClass)) excluded.push('CPU credits above the baseline')
  if (attrs.publiclyAccessible === true) excluded.push('Public IPv4 address')

  return { components, excluded }
}

// ---------------------------------------------------------------------------
// Load balancers
// ---------------------------------------------------------------------------

/** Type -> product family, and the usage charge the hourly rate leaves out. */
const LOAD_BALANCER: Record<string, { productFamily: string; usageCharge: string }> = {
  application: { productFamily: 'Load Balancer-Application', usageCharge: 'Capacity units (LCU), by traffic' },
  network: { productFamily: 'Load Balancer-Network', usageCharge: 'Capacity units (NLCU), by traffic' },
  gateway: { productFamily: 'Load Balancer-Gateway', usageCharge: 'Capacity units (GLCU), by traffic' },
  classic: { productFamily: 'Load Balancer', usageCharge: DATA_PROCESSED }
}

function loadBalancer(resource: Resource): PricePlan {
  const type = text(resource.attrs.type)
  const mapped = type ? LOAD_BALANCER[type] : undefined
  if (!mapped) return unknown(`Unknown load balancer type "${type ?? ''}".`)

  const excluded = [mapped.usageCharge]
  // How many addresses it holds changes with load, so they are named, not counted.
  if (resource.attrs.scheme === 'internet-facing') excluded.push('Public IPv4 addresses, at least one per zone')

  return {
    components: [
      {
        query: {
          serviceCode: 'AWSELB',
          filters: { regionCode: resource.region, productFamily: mapped.productFamily },
          usageType: 'LoadBalancerUsage',
          unit: 'hour'
        },
        quantity: 1
      }
    ],
    excluded
  }
}

// ---------------------------------------------------------------------------
// SageMaker endpoints
// ---------------------------------------------------------------------------

/** States in which it is not certain the instances are billed. */
const SAGEMAKER_UNCERTAIN = new Set(['creating', 'failed', 'deleting'])

function sagemakerEndpoint(resource: Resource): PricePlan {
  const excluded = [DATA_PROCESSED]
  if (SAGEMAKER_UNCERTAIN.has(resource.state)) {
    return unknown(`The endpoint is ${resource.state}; whether its instances are billed is not certain.`, excluded)
  }

  let variants: unknown
  try {
    variants = JSON.parse(String(resource.attrs.variants))
  } catch {
    return unknown('The endpoint variants could not be read.', excluded)
  }
  if (!Array.isArray(variants) || variants.length === 0) return unknown('The endpoint has no variants.', excluded)

  // One component per instance type, however many variants share it.
  const counts = new Map<string, number>()
  for (const variant of variants as { instanceType?: unknown; instanceCount?: unknown; serverless?: unknown }[]) {
    if (variant?.serverless === true) {
      return unknown('Has a serverless variant, which is billed per request, not per hour.', excluded)
    }
    const instanceType = text(variant?.instanceType)
    const count = amount(variant?.instanceCount)
    if (!instanceType || count === null) return unknown('The instance type of a variant is not known.', excluded)
    counts.set(instanceType, (counts.get(instanceType) ?? 0) + count)
  }

  return {
    components: [...counts].map(([instanceName, quantity]) => ({
      query: {
        serviceCode: 'AmazonSageMaker',
        filters: { regionCode: resource.region, instanceName },
        usageType: `Host:${instanceName}`,
        unit: 'hour' as const
      },
      quantity
    })),
    excluded
  }
}

// ---------------------------------------------------------------------------

export function pricePlan(resource: Resource, ctx: PlanContext): PricePlan {
  switch (resource.kind) {
    case 'ec2-instance':
      return ec2Instance(resource, ctx)
    case 'ebs-volume':
      return ebsVolume(resource)
    case 'elastic-ip':
      return elasticIp(resource)
    case 'nat-gateway':
      return natGateway(resource)
    case 'rds-instance':
      return rdsInstance(resource)
    case 'load-balancer':
      return loadBalancer(resource)
    case 'sagemaker-endpoint':
      return sagemakerEndpoint(resource)
  }
}
