// A pretend AWS account for development and the end-to-end tests. Switched on
// with WATCHDOG_FAKE_AWS, and only when the app is NOT packaged (index.ts
// checks), so an installed copy can never show made-up data.
//
// The clients are real SDK clients, so paginators and the rest of the app
// treat them as usual. Only `send` is replaced: it answers each command the
// app makes from the small data set below. No request ever leaves the machine
// and no credentials are read.
//
// Scenarios:
//   demo             a free-plan account with credits, and a few typical
//                    resources that raise flags
//   freetier-denied  the same, but the Free Tier API refuses (degraded path)
//
// The pretend account can also be told to stop an instance: from then on it
// reports that instance as stopped. Nothing else about it ever changes.

import { CloudWatchClient, GetMetricDataCommand, type GetMetricDataCommandInput } from '@aws-sdk/client-cloudwatch'
import {
  DescribeAddressesCommand,
  DescribeInstancesCommand,
  DescribeInstanceTypesCommand,
  DescribeNatGatewaysCommand,
  DescribeRegionsCommand,
  DescribeVolumesCommand,
  EC2Client,
  StopInstancesCommand,
  type Instance
} from '@aws-sdk/client-ec2'
import { ElasticLoadBalancingClient, DescribeLoadBalancersCommand as DescribeClassicLoadBalancersCommand } from '@aws-sdk/client-elastic-load-balancing'
import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand } from '@aws-sdk/client-elastic-load-balancing-v2'
import { FreeTierClient, GetAccountPlanStateCommand, GetFreeTierUsageCommand } from '@aws-sdk/client-freetier'
import { GetProductsCommand, PricingClient, type GetProductsCommandInput } from '@aws-sdk/client-pricing'
import { DescribeDBInstancesCommand, RDSClient, StopDBInstanceCommand } from '@aws-sdk/client-rds'
import { ListEndpointsCommand, SageMakerClient } from '@aws-sdk/client-sagemaker'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { createClientFactory, type ClientFactory } from '../core/aws/clients'
import bundledSnapshot from '../core/pricing/bundledPrices.json' with { type: 'json' }

export const FAKE_SCENARIOS = ['demo', 'freetier-denied'] as const
export type FakeScenario = (typeof FAKE_SCENARIOS)[number]

export const FAKE_ACCOUNT_ID = '111122223333'
export const FAKE_PROFILE = 'demo'
const FAKE_REGIONS = ['eu-west-1', 'us-east-1']

/** The scenario named by WATCHDOG_FAKE_AWS: "1" means demo. null = fake mode is off. */
export function fakeScenarioFrom(value: string | undefined): FakeScenario | null {
  if (!value) return null
  if (value === '1' || value === 'true') return 'demo'
  return (FAKE_SCENARIOS as readonly string[]).includes(value) ? (value as FakeScenario) : null
}

const HOUR_MS = 3_600_000

function awsError(name: string, message: string, httpStatusCode = 403): Error {
  return Object.assign(new Error(message), { name, $metadata: { httpStatusCode } })
}

/** What has been done to one pretend account since it was created. */
interface FakeState {
  stoppedInstances: Set<string>
}

type Command = { input: unknown }

/** Price List products built from the bundled snapshot, in the shape GetProducts returns. */
function products(input: GetProductsCommandInput): string[] {
  const units: Record<string, string> = { hour: 'Hrs', 'gb-month': 'GB-Mo', 'iops-month': 'IOPS-Mo', 'gibps-month': 'GiBps-mo' }
  const wanted = new Map((input.Filters ?? []).map((filter) => [filter.Field, filter.Value]))
  const found: string[] = []
  for (const [key, usd] of Object.entries(bundledSnapshot.prices)) {
    const [serviceCode, filterText, usageType, unit] = key.split('|')
    if (serviceCode !== input.ServiceCode || !filterText || !usageType || !unit) continue
    const filters = new Map(filterText.split('&').map((pair) => pair.split('=') as [string, string]))
    if (filters.size !== wanted.size || [...wanted].some(([field, value]) => filters.get(field!) !== value)) continue
    const sku = `FAKE${found.length}`
    found.push(
      JSON.stringify({
        product: { sku, attributes: { ...Object.fromEntries(filters), usagetype: usageType } },
        terms: { OnDemand: { [`${sku}.T`]: { priceDimensions: { [`${sku}.T.D`]: { unit: units[unit], pricePerUnit: { USD: String(usd) } } } } } }
      })
    )
  }
  return found
}

function answer(scenario: FakeScenario, state: FakeState, region: string, command: Command): unknown {
  const now = Date.now()
  const ago = (hours: number) => new Date(now - hours * HOUR_MS)
  const home = region === 'eu-west-1'

  if (command instanceof GetCallerIdentityCommand) {
    return { Account: FAKE_ACCOUNT_ID, Arn: `arn:aws:iam::${FAKE_ACCOUNT_ID}:user/demo`, UserId: 'AIDAFAKEFAKEFAKEFAKE' }
  }
  if (command instanceof DescribeRegionsCommand) {
    return { Regions: FAKE_REGIONS.map((RegionName) => ({ RegionName, OptInStatus: 'opt-in-not-required' })) }
  }
  if (command instanceof DescribeInstancesCommand) {
    const wanted = command.input.InstanceIds
    const notFound = (id: string) => awsError('InvalidInstanceID.NotFound', `The instance ID '${id}' does not exist`, 400)
    if (!home) {
      if (wanted?.[0]) throw notFound(wanted[0])
      return { Reservations: [] }
    }
    const base = { UsageOperation: 'RunInstances', PlatformDetails: 'Linux/UNIX', Placement: { Tenancy: 'default' as const }, RootDeviceType: 'ebs' as const }
    const instances: Instance[] = [
      {
        ...base,
        InstanceId: 'i-0demo0000000web01',
        InstanceType: 't3.micro',
        State: { Name: 'running', Code: 16 },
        LaunchTime: ago(30),
        PublicIpAddress: '203.0.113.10',
        NetworkInterfaces: [{ Association: { PublicIp: '203.0.113.10', IpOwnerId: 'amazon' } }],
        Tags: [{ Key: 'Name', Value: 'hackathon-api' }]
      },
      {
        ...base,
        InstanceId: 'i-0demo00000train01',
        InstanceType: 'g4dn.xlarge',
        State: { Name: 'running', Code: 16 },
        LaunchTime: ago(3),
        Tags: [{ Key: 'Name', Value: 'model-training' }]
      },
      {
        ...base,
        InstanceId: 'i-0demo0000000old01',
        InstanceType: 't3.micro',
        State: { Name: 'stopped', Code: 80 },
        LaunchTime: ago(400),
        Tags: [{ Key: 'Name', Value: 'old-prototype' }]
      }
    ]
    const current = instances.map((instance): Instance => {
      if (!state.stoppedInstances.has(instance.InstanceId!)) return instance
      // A stopped instance gives back its automatic public address.
      const { PublicIpAddress: _released, NetworkInterfaces: _detached, ...rest } = instance
      return { ...rest, State: { Name: 'stopped', Code: 80 } }
    })
    const missing = wanted?.find((id) => !current.some((instance) => instance.InstanceId === id))
    if (missing) throw notFound(missing)
    return { Reservations: [{ Instances: wanted ? current.filter((instance) => wanted.includes(instance.InstanceId!)) : current }] }
  }
  if (command instanceof DescribeInstanceTypesCommand) {
    // As in AWS: the GPU type comes with an instance-store disk, the small one does not.
    return {
      InstanceTypes: (command.input.InstanceTypes ?? []).map((InstanceType) => ({
        InstanceType,
        InstanceStorageSupported: InstanceType.startsWith('g4dn.')
      }))
    }
  }
  if (command instanceof StopInstancesCommand) {
    if (command.input.DryRun) throw awsError('DryRunOperation', 'Request would have succeeded, but DryRun flag is set.', 412)
    for (const id of command.input.InstanceIds ?? []) state.stoppedInstances.add(id)
    return {}
  }
  // The pretend account has no databases.
  if (command instanceof StopDBInstanceCommand) {
    throw awsError('DBInstanceNotFoundFault', `DBInstance ${command.input.DBInstanceIdentifier} not found.`, 404)
  }
  if (command instanceof DescribeVolumesCommand) {
    if (!home) return { Volumes: [] }
    return {
      Volumes: [
        {
          VolumeId: 'vol-0demo0000000root1',
          VolumeType: 'gp3',
          Size: 8,
          Iops: 3000,
          Throughput: 125,
          State: 'in-use',
          CreateTime: ago(30),
          Attachments: [{ InstanceId: 'i-0demo0000000web01', State: 'attached' }]
        },
        { VolumeId: 'vol-0demo00000spare1', VolumeType: 'gp2', Size: 20, Iops: 100, State: 'available', CreateTime: ago(200), Attachments: [] }
      ]
    }
  }
  if (command instanceof DescribeAddressesCommand) {
    if (!home) return { Addresses: [] }
    return { Addresses: [{ AllocationId: 'eipalloc-0demo00000001', PublicIp: '203.0.113.20', PublicIpv4Pool: 'amazon', Domain: 'vpc' }] }
  }
  if (command instanceof DescribeNatGatewaysCommand) {
    if (!home) return { NatGateways: [] }
    return {
      NatGateways: [
        {
          NatGatewayId: 'nat-0demo000000000001',
          State: 'available',
          ConnectivityType: 'public',
          AvailabilityMode: 'zonal',
          CreateTime: ago(50),
          Tags: [{ Key: 'Name', Value: 'demo-nat' }]
        }
      ]
    }
  }
  if (command instanceof DescribeDBInstancesCommand) return { DBInstances: [] }
  if (command instanceof DescribeLoadBalancersCommand) return { LoadBalancers: [] }
  if (command instanceof DescribeClassicLoadBalancersCommand) return { LoadBalancerDescriptions: [] }
  if (command instanceof ListEndpointsCommand) return { Endpoints: [] }

  if (command instanceof GetProductsCommand) return { PriceList: products(command.input) }

  if (command instanceof GetAccountPlanStateCommand) {
    if (scenario === 'freetier-denied') {
      throw awsError('AccessDeniedException', 'User is not authorized to perform: freetier:GetAccountPlanState')
    }
    return {
      accountId: FAKE_ACCOUNT_ID,
      accountPlanType: 'FREE',
      accountPlanStatus: 'ACTIVE',
      accountPlanRemainingCredits: { amount: 87.5, unit: 'USD' },
      accountPlanExpirationDate: new Date(now + 120 * 24 * HOUR_MS)
    }
  }
  if (command instanceof GetFreeTierUsageCommand) return { freeTierUsages: [] }

  if (command instanceof GetMetricDataCommand) {
    const input = command.input as GetMetricDataCommandInput
    // Every instance asked about has idled for the whole window.
    const hours = Math.round(((input.EndTime as Date).getTime() - (input.StartTime as Date).getTime()) / HOUR_MS)
    return {
      MetricDataResults: (input.MetricDataQueries ?? []).map((query) => ({
        Id: query.Id,
        Values: Array.from({ length: hours }, (_, i) => 0.3 + (i % 3) * 0.2),
        StatusCode: 'Complete'
      }))
    }
  }

  throw new Error(`Fake AWS has no answer for ${command.constructor.name}.`)
}

const CLIENTS = [
  STSClient,
  EC2Client,
  RDSClient,
  ElasticLoadBalancingClient,
  ElasticLoadBalancingV2Client,
  SageMakerClient,
  PricingClient,
  FreeTierClient,
  CloudWatchClient
]

export function createFakeClientFactory(scenario: FakeScenario): ClientFactory {
  const real = createClientFactory({
    profile: FAKE_PROFILE,
    // Never used: `send` is replaced before any request is made.
    credentials: async () => ({ accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'fake' })
  })
  const patched = new WeakSet<object>()
  const state: FakeState = { stoppedInstances: new Set() }

  return {
    profile: FAKE_PROFILE,
    get(service, region) {
      const client = real.get(service, region)
      if (!patched.has(client)) {
        if (!CLIENTS.some((known) => client instanceof known)) throw new Error(`Fake AWS does not know ${service.name}.`)
        const fake = async (command: Command) => answer(scenario, state, region, command)
        ;(client as unknown as { send: typeof fake }).send = fake
        patched.add(client)
      }
      return client
    },
    destroy: () => real.destroy()
  }
}
