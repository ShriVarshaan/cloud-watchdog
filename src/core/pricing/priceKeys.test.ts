import { describe, expect, it } from 'vitest'
import type { AttrValue, Resource, ResourceKind } from '../../shared/types'
import { planContext, pricePlan, type PricePlan } from './priceKeys'

const ACCOUNT = '111122223333'

function make(kind: ResourceKind, state: string, attrs: Record<string, AttrValue>, region = 'eu-west-1'): Resource {
  return { key: `${ACCOUNT}:${kind}:${region}:x`, kind, region, id: 'x', state, attrs }
}

const NO_CONTEXT = planContext([])
const plan = (resource: Resource, others: Resource[] = []): PricePlan => pricePlan(resource, planContext([resource, ...others]))

/** [serviceCode, filters, usageType, unit, quantity] for each component, to keep the tables readable. */
function parts(p: PricePlan) {
  return p.components.map((c) => [c.query.serviceCode, c.query.filters, c.query.usageType, c.query.unit, c.quantity])
}

describe('EC2 instances', () => {
  const linux = {
    instanceType: 't3.micro',
    platformDetails: 'Linux/UNIX',
    usageOperation: 'RunInstances',
    tenancy: 'default',
    lifecycle: 'on-demand',
    publicIp: null,
    rootDeviceType: 'ebs',
    autoScalingGroup: null
  }

  it('prices a running instance by type, billing operation and tenancy', () => {
    const p = plan(make('ec2-instance', 'running', linux))
    expect(p.unknown).toBeUndefined()
    expect(p.upperBound).toBeFalsy()
    expect(parts(p)).toEqual([
      [
        'AmazonEC2',
        { regionCode: 'eu-west-1', instanceType: 't3.micro', operation: 'RunInstances', tenancy: 'Shared', capacitystatus: 'Used' },
        'BoxUsage:t3.micro',
        'hour',
        1
      ]
    ])
  })

  it('uses the operation code of the operating system, e.g. Windows', () => {
    const p = plan(make('ec2-instance', 'running', { ...linux, usageOperation: 'RunInstances:0002' }))
    expect(p.components[0]!.query.filters.operation).toBe('RunInstances:0002')
  })

  it('prices dedicated tenancy with its own usage type', () => {
    const p = plan(make('ec2-instance', 'running', { ...linux, tenancy: 'dedicated' }))
    expect(p.components[0]!.query.filters.tenancy).toBe('Dedicated')
    expect(p.components[0]!.query.usageType).toBe('DedicatedUsage:t3.micro')
    expect(p.excluded).toContain('Dedicated instance fee per region')
  })

  it('adds the public IPv4 charge for an address that is not an Elastic IP', () => {
    const p = plan(make('ec2-instance', 'running', { ...linux, publicIp: '203.0.113.9' }))
    expect(parts(p)[1]).toEqual([
      'AmazonVPC',
      { regionCode: 'eu-west-1', group: 'VPCPublicIPv4Address' },
      'PublicIPv4:InUseAddress',
      'hour',
      1
    ])
  })

  it('does not charge the address twice when it is an Elastic IP, which is priced as its own resource', () => {
    const address = make('elastic-ip', 'associated', { publicIp: '203.0.113.9', publicIpv4Pool: 'amazon' })
    const p = plan(make('ec2-instance', 'running', { ...linux, publicIp: '203.0.113.9' }), [address])
    expect(p.components).toHaveLength(1)
  })

  it('still charges the address when the same IP is an Elastic IP in another region only', () => {
    const elsewhere = make('elastic-ip', 'associated', { publicIp: '203.0.113.9', publicIpv4Pool: 'amazon' }, 'us-east-1')
    const p = plan(make('ec2-instance', 'running', { ...linux, publicIp: '203.0.113.9' }), [elsewhere])
    expect(p.components).toHaveLength(2)
  })

  it.each(['stopped', 'stopping', 'pending', 'shutting-down'])('costs nothing for compute while %s', (state) => {
    const p = plan(make('ec2-instance', state, linux))
    expect(p.components).toEqual([])
    expect(p.unknown).toBeUndefined()
  })

  it('marks a spot instance as an upper bound: it is priced at the on-demand rate', () => {
    const p = plan(make('ec2-instance', 'running', { ...linux, lifecycle: 'spot' }))
    expect(p.upperBound).toBe(true)
    expect(p.components).toHaveLength(1)
  })

  it('lists what the rate leaves out, with CPU credits only for burstable types', () => {
    expect(plan(make('ec2-instance', 'running', linux)).excluded).toEqual([
      'Data transfer',
      'CPU credits above the baseline (unlimited mode)'
    ])
    expect(plan(make('ec2-instance', 'running', { ...linux, instanceType: 'g4dn.xlarge' })).excluded).toEqual(['Data transfer'])
  })

  it.each([
    ['the instance type is missing', { instanceType: null }],
    ['the billing operation is missing', { usageOperation: null }],
    ['the tenancy is missing', { tenancy: null }],
    ['it runs on a Dedicated Host, which bills per host', { tenancy: 'host' }],
    ['the purchase option is one the app does not know', { lifecycle: 'capacity-block' }]
  ])('gives no price when %s', (_why, override) => {
    const p = plan(make('ec2-instance', 'running', { ...linux, ...override }))
    expect(p.unknown).toEqual(expect.any(String))
  })
})

describe('EBS volumes', () => {
  const volume = (attrs: Record<string, AttrValue>) =>
    make('ebs-volume', 'in-use', { attachedInstanceId: 'i-1', attachmentCount: 1, throughputMibps: null, iops: null, ...attrs })
  const storage = (volumeApiName: string) => ({ regionCode: 'eu-west-1', productFamily: 'Storage', volumeApiName })

  it.each([
    ['gp2', 'EBS:VolumeUsage.gp2', 100],
    ['st1', 'EBS:VolumeUsage.st1', null],
    ['sc1', 'EBS:VolumeUsage.sc1', null],
    ['standard', 'EBS:VolumeUsage', null]
  ])('prices a %s volume by its size only', (volumeType, usageType, iops) => {
    const p = plan(volume({ volumeType, sizeGb: 30, iops }))
    expect(p.unknown).toBeUndefined()
    expect(parts(p)).toEqual([['AmazonEC2', storage(volumeType), usageType, 'gb-month', 30]])
  })

  it('prices a gp3 volume at its baseline by size only', () => {
    const p = plan(volume({ volumeType: 'gp3', sizeGb: 8, iops: 3000, throughputMibps: 125 }))
    expect(parts(p)).toEqual([['AmazonEC2', storage('gp3'), 'EBS:VolumeUsage.gp3', 'gb-month', 8]])
  })

  it('adds gp3 IOPS above 3000 and throughput above 125 MiB/s', () => {
    const p = plan(volume({ volumeType: 'gp3', sizeGb: 100, iops: 4000, throughputMibps: 381 }))
    expect(parts(p)).toEqual([
      ['AmazonEC2', storage('gp3'), 'EBS:VolumeUsage.gp3', 'gb-month', 100],
      [
        'AmazonEC2',
        { regionCode: 'eu-west-1', productFamily: 'System Operation', volumeApiName: 'gp3' },
        'EBS:VolumeP-IOPS.gp3',
        'iops-month',
        1000
      ],
      [
        'AmazonEC2',
        { regionCode: 'eu-west-1', productFamily: 'Provisioned Throughput', volumeApiName: 'gp3' },
        'EBS:VolumeP-Throughput.gp3',
        'gibps-month',
        0.25 // (381 - 125) MiB/s = 256 MiB/s = 0.25 GiB/s
      ]
    ])
  })

  it('charges every provisioned IOPS of an io1 volume', () => {
    const p = plan(volume({ volumeType: 'io1', sizeGb: 50, iops: 2000 }))
    expect(parts(p)).toEqual([
      ['AmazonEC2', storage('io1'), 'EBS:VolumeUsage.piops', 'gb-month', 50],
      [
        'AmazonEC2',
        { regionCode: 'eu-west-1', productFamily: 'System Operation', volumeApiName: 'io1' },
        'EBS:VolumeP-IOPS.piops',
        'iops-month',
        2000
      ]
    ])
  })

  it('charges io2 IOPS at the first tier up to 32,000', () => {
    const p = plan(volume({ volumeType: 'io2', sizeGb: 50, iops: 32000 }))
    expect(parts(p)[1]).toEqual([
      'AmazonEC2',
      { regionCode: 'eu-west-1', productFamily: 'System Operation', volumeApiName: 'io2' },
      'EBS:VolumeP-IOPS.io2',
      'iops-month',
      32000
    ])
  })

  it('gives no price for io2 above 32,000 IOPS, where cheaper tiers start', () => {
    expect(plan(volume({ volumeType: 'io2', sizeGb: 50, iops: 32001 })).unknown).toEqual(expect.any(String))
  })

  it('notes the per-request charge of magnetic volumes', () => {
    expect(plan(volume({ volumeType: 'standard', sizeGb: 30 })).excluded).toEqual(['I/O requests'])
  })

  it.each([
    ['the type is missing', { volumeType: null, sizeGb: 30 }],
    ['the type is new to the app', { volumeType: 'gp4', sizeGb: 30 }],
    ['the size is missing', { volumeType: 'gp2', sizeGb: null }],
    ['a gp3 volume has no IOPS figure', { volumeType: 'gp3', sizeGb: 30, iops: null, throughputMibps: 125 }],
    ['a gp3 volume has no throughput figure', { volumeType: 'gp3', sizeGb: 30, iops: 3000, throughputMibps: null }],
    ['an io1 volume has no IOPS figure', { volumeType: 'io1', sizeGb: 30, iops: null }]
  ])('gives no price when %s', (_why, attrs) => {
    expect(plan(volume(attrs)).unknown).toEqual(expect.any(String))
  })
})

describe('Elastic IPs', () => {
  const filters = { regionCode: 'eu-west-1', group: 'VPCPublicIPv4Address' }
  const address = (state: string, publicIpv4Pool: string | null = 'amazon') =>
    make('elastic-ip', state, { publicIp: '203.0.113.9', associatedInstanceId: null, networkInterfaceId: null, publicIpv4Pool })

  it('prices an address in use', () => {
    expect(parts(plan(address('associated')))).toEqual([['AmazonVPC', filters, 'PublicIPv4:InUseAddress', 'hour', 1]])
  })

  it('prices an idle address', () => {
    expect(parts(plan(address('unassociated')))).toEqual([['AmazonVPC', filters, 'PublicIPv4:IdleAddress', 'hour', 1]])
  })

  it('gives no price for an address from a pool the account brought itself', () => {
    expect(plan(address('associated', 'ipv4pool-ec2-0123456789abcdef0')).unknown).toEqual(expect.any(String))
  })
})

describe('NAT gateways', () => {
  it.each(['available', 'pending', 'deleting'])('prices a zonal gateway by the hour while %s', (state) => {
    const p = plan(make('nat-gateway', state, { connectivityType: 'public', availabilityMode: 'zonal' }))
    expect(parts(p)).toEqual([
      ['AmazonEC2', { regionCode: 'eu-west-1', productFamily: 'NAT Gateway', operation: 'NatGateway' }, 'NatGateway-Hours', 'hour', 1]
    ])
    expect(p.excluded).toEqual(['Data processed, per GB', 'Data transfer'])
  })

  it('gives no price for a regional gateway, which bills per zone it is active in', () => {
    const p = plan(make('nat-gateway', 'available', { connectivityType: 'public', availabilityMode: 'regional' }))
    expect(p.unknown).toEqual(expect.any(String))
    expect(p.excluded).toContain('Data processed, per GB')
  })
})

describe('RDS instances', () => {
  const mysql = {
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
    publiclyAccessible: false
  }
  const instanceFilters = (databaseEngine: string, deploymentOption: string, instanceType = 'db.t3.micro') => ({
    regionCode: 'eu-west-1',
    productFamily: 'Database Instance',
    instanceType,
    databaseEngine,
    deploymentOption
  })
  const storageFilters = (databaseEngine: string, deploymentOption: string) => ({
    regionCode: 'eu-west-1',
    productFamily: 'Database Storage',
    databaseEngine,
    deploymentOption
  })

  it('prices an available instance as instance hours plus storage', () => {
    const p = plan(make('rds-instance', 'available', mysql))
    expect(p.unknown).toBeUndefined()
    expect(parts(p)).toEqual([
      ['AmazonRDS', instanceFilters('MySQL', 'Single-AZ'), 'InstanceUsage:db.t3.micro', 'hour', 1],
      ['AmazonRDS', storageFilters('MySQL', 'Single-AZ'), 'RDS:GP3-Storage', 'gb-month', 20]
    ])
  })

  it('prices a Multi-AZ instance with the Multi-AZ rates for both parts', () => {
    const p = plan(make('rds-instance', 'available', { ...mysql, engine: 'postgres', multiAz: true, storageType: 'gp2' }))
    expect(parts(p)).toEqual([
      ['AmazonRDS', instanceFilters('PostgreSQL', 'Multi-AZ'), 'Multi-AZUsage:db.t3.micro', 'hour', 1],
      ['AmazonRDS', storageFilters('PostgreSQL', 'Multi-AZ'), 'RDS:Multi-AZ-GP2-Storage', 'gb-month', 20]
    ])
  })

  it.each([
    ['mysql', 'MySQL'],
    ['postgres', 'PostgreSQL'],
    ['mariadb', 'MariaDB']
  ])('maps engine %s to "%s"', (engine, databaseEngine) => {
    const p = plan(make('rds-instance', 'available', { ...mysql, engine }))
    expect(p.components[0]!.query.filters.databaseEngine).toBe(databaseEngine)
  })

  it.each([
    ['gp2', 'RDS:GP2-Storage'],
    ['gp3', 'RDS:GP3-Storage'],
    ['io1', 'RDS:PIOPS-Storage'],
    ['io2', 'RDS:PIOPS-Storage-IO2'],
    ['standard', 'RDS:StorageUsage']
  ])('maps storage type %s to usage type %s', (storageType, usageType) => {
    const p = plan(make('rds-instance', 'available', { ...mysql, storageType }))
    expect(p.components[1]!.query.usageType).toBe(usageType)
  })

  it('charges a stopped instance for its storage only', () => {
    const p = plan(make('rds-instance', 'stopped', mysql))
    expect(parts(p)).toEqual([['AmazonRDS', storageFilters('MySQL', 'Single-AZ'), 'RDS:GP3-Storage', 'gb-month', 20]])
  })

  it('lists what the rate leaves out', () => {
    expect(plan(make('rds-instance', 'available', mysql)).excluded).toEqual([
      'Backup storage beyond the free allowance',
      'Data transfer',
      'CPU credits above the baseline'
    ])
    const big = { ...mysql, instanceClass: 'db.m5.large', storageType: 'io1', iops: 3000, publiclyAccessible: true }
    expect(plan(make('rds-instance', 'available', big)).excluded).toEqual([
      'Backup storage beyond the free allowance',
      'Data transfer',
      'Provisioned IOPS',
      'Public IPv4 address'
    ])
  })

  it('notes provisioned IOPS on gp3 storage only when some are set', () => {
    const p = plan(make('rds-instance', 'available', { ...mysql, iops: 12000 }))
    expect(p.excluded).toContain('Provisioned IOPS and throughput above the gp3 baseline')
  })

  it.each([
    ['the instance class is missing', { instanceClass: null }],
    ['the engine is one the app has no recorded prices for', { engine: 'sqlserver-ex' }],
    ['it is an Aurora cluster member', { engine: 'aurora-mysql', clusterId: 'shop' }],
    ['it belongs to a Multi-AZ DB cluster', { clusterId: 'shop' }],
    ['Multi-AZ is not reported', { multiAz: null }],
    ['the storage type is new to the app', { storageType: 'gp4' }],
    ['the storage size is missing', { allocatedStorageGb: null }]
  ])('gives no price when %s', (_why, override) => {
    expect(plan(make('rds-instance', 'available', { ...mysql, ...override })).unknown).toEqual(expect.any(String))
  })
})

describe('load balancers', () => {
  const lb = (type: string | null, scheme: string | null = 'internal') =>
    make('load-balancer', 'active', { type, scheme, ipAddressType: 'ipv4', zoneCount: 2 })

  it.each([
    ['application', 'Load Balancer-Application', 'Capacity units (LCU), by traffic'],
    ['network', 'Load Balancer-Network', 'Capacity units (NLCU), by traffic'],
    ['gateway', 'Load Balancer-Gateway', 'Capacity units (GLCU), by traffic'],
    ['classic', 'Load Balancer', 'Data processed, per GB']
  ])('prices a %s load balancer by the hour', (type, productFamily, usageCharge) => {
    const p = plan(lb(type))
    expect(parts(p)).toEqual([['AWSELB', { regionCode: 'eu-west-1', productFamily }, 'LoadBalancerUsage', 'hour', 1]])
    expect(p.excluded).toEqual([usageCharge])
  })

  it('notes the public addresses of an internet-facing load balancer', () => {
    expect(plan(lb('application', 'internet-facing')).excluded).toEqual([
      'Capacity units (LCU), by traffic',
      'Public IPv4 addresses, at least one per zone'
    ])
  })

  it('gives no price for a type it does not know', () => {
    expect(plan(lb(null)).unknown).toEqual(expect.any(String))
  })
})

describe('SageMaker endpoints', () => {
  const variant = (over: object = {}) => ({
    name: 'AllTraffic',
    instanceType: 'ml.t2.medium',
    instanceCount: 1,
    serverless: false,
    shadow: false,
    ...over
  })
  const endpoint = (variants: unknown, state = 'in-service') =>
    make('sagemaker-endpoint', state, { variants: JSON.stringify(variants), instanceCount: 0, serverless: false })
  const hosting = (instanceName: string) => ['AmazonSageMaker', { regionCode: 'eu-west-1', instanceName }, `Host:${instanceName}`, 'hour']

  it('prices each variant as instance type times instance count, shadow variants included', () => {
    const p = plan(
      endpoint([variant({ instanceCount: 2 }), variant({ name: 'shadow', instanceType: 'ml.m5.large', shadow: true })])
    )
    expect(p.unknown).toBeUndefined()
    expect(parts(p)).toEqual([
      [...hosting('ml.t2.medium'), 2],
      [...hosting('ml.m5.large'), 1]
    ])
    expect(p.excluded).toEqual(['Data processed, per GB'])
  })

  it.each([
    ['a variant is serverless, which bills per request', [variant(), variant({ instanceType: null, instanceCount: 0, serverless: true })]],
    ['a variant has no instance type (its config was deleted)', [variant({ instanceType: null })]],
    ['there are no variants', []],
    ['the variant list is not a list', { oops: true }]
  ])('gives no price when %s', (_why, variants) => {
    expect(plan(endpoint(variants)).unknown).toEqual(expect.any(String))
  })

  it('gives no price when the variant list cannot be read', () => {
    const broken = make('sagemaker-endpoint', 'in-service', { variants: '{not json', instanceCount: 1, serverless: false })
    expect(pricePlan(broken, NO_CONTEXT).unknown).toEqual(expect.any(String))
  })

  it.each(['creating', 'failed', 'deleting'])('gives no price while %s, when billing is not certain', (state) => {
    expect(plan(endpoint([variant()], state)).unknown).toEqual(expect.any(String))
  })
})
