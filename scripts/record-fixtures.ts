// Records real AWS responses as test fixtures. You run this by hand, once,
// against your own account. Automated tests never call AWS.
//
//   npm run record-fixtures -- --profile <name> [--regions eu-west-1,us-east-1]
//
// It makes read-only calls only (the same ones the scanners make):
//   sts:GetCallerIdentity, ec2:DescribeRegions, ec2:DescribeInstances,
//   ec2:DescribeVolumes, ec2:DescribeAddresses, ec2:DescribeNatGateways,
//   rds:DescribeDBInstances, elasticloadbalancing:DescribeLoadBalancers
//   (ELBv2 and classic), sagemaker:ListEndpoints, sagemaker:DescribeEndpoint,
//   sagemaker:DescribeEndpointConfig
//
// Output:
//   tests/fixtures/_raw/      exact responses. Ignored by git. Never commit.
//   tests/fixtures/recorded/  sanitised copies (see sanitize.ts).
//
// READ every file in tests/fixtures/recorded/ before committing it. The
// sanitiser is a best effort and cannot know every field.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  DescribeAddressesCommand,
  DescribeRegionsCommand,
  EC2Client,
  paginateDescribeInstances,
  paginateDescribeNatGateways,
  paginateDescribeVolumes
} from '@aws-sdk/client-ec2'
import {
  ElasticLoadBalancingClient,
  paginateDescribeLoadBalancers as paginateClassicLoadBalancers
} from '@aws-sdk/client-elastic-load-balancing'
import {
  ElasticLoadBalancingV2Client,
  paginateDescribeLoadBalancers as paginateV2LoadBalancers
} from '@aws-sdk/client-elastic-load-balancing-v2'
import { paginateDescribeDBInstances, RDSClient } from '@aws-sdk/client-rds'
import {
  DescribeEndpointCommand,
  DescribeEndpointConfigCommand,
  paginateListEndpoints,
  SageMakerClient
} from '@aws-sdk/client-sagemaker'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import { createSanitizer } from './sanitize.ts'

const HOME_REGION = 'us-east-1'
const RAW_DIR = join('tests', 'fixtures', '_raw')
const SANITISED_DIR = join('tests', 'fixtures', 'recorded')

const USAGE = `Usage: npm run record-fixtures -- --profile <name> [--regions eu-west-1,us-east-1]

  --profile  AWS profile to record from (required)
  --regions  comma-separated regions; default: every region enabled for the account`

async function allPages<Page>(pages: AsyncIterable<Page>): Promise<Page[]> {
  const all: Page[] = []
  for await (const page of pages) all.push(page)
  return all
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

  const credentials = fromNodeProviderChain({ profile: values.profile })
  const config = (region: string) => ({ region, credentials, retryMode: 'adaptive' as const, maxAttempts: 5 })

  const identity = await new STSClient(config(HOME_REGION)).send(new GetCallerIdentityCommand({}))
  if (!identity.Account) throw new Error('AWS did not return an account id for this profile.')
  console.log(`Recording from account ${identity.Account} (${identity.Arn})`)

  const sanitize = createSanitizer(identity.Account)
  mkdirSync(RAW_DIR, { recursive: true })
  mkdirSync(SANITISED_DIR, { recursive: true })
  const written: string[] = []

  /** Writes the exact response to _raw/ and the sanitised copy to recorded/. */
  const save = (name: string, response: unknown) => {
    // Through JSON first: dates become ISO strings, as they are stored in the files.
    const plain: unknown = JSON.parse(JSON.stringify(response))
    writeFileSync(join(RAW_DIR, `${name}.json`), JSON.stringify(plain, null, 2) + '\n')
    writeFileSync(join(SANITISED_DIR, `${name}.json`), JSON.stringify(sanitize(plain), null, 2) + '\n')
    written.push(`${name}.json`)
  }

  save('sts-get-caller-identity', identity)

  const regionsResponse = await new EC2Client(config(HOME_REGION)).send(new DescribeRegionsCommand({ AllRegions: false }))
  save('ec2-describe-regions', regionsResponse)

  const regions = values.regions
    ? values.regions.split(',').map((region) => region.trim()).filter(Boolean)
    : (regionsResponse.Regions ?? []).map((region) => region.RegionName).filter((name): name is string => !!name)

  /**
   * Fetches one kind of resource in one region and saves it if there is any.
   * A failure is reported and recording carries on with the next call.
   */
  const record = async <T>(
    region: string,
    file: string,
    what: string,
    fetch: () => Promise<T>,
    count: (data: T) => number
  ) => {
    try {
      const data = await fetch()
      const n = count(data)
      if (n > 0) save(`${file}.${region}`, data)
      console.log(`${region}: ${n} ${what}`)
    } catch (error) {
      console.error(`${region}: ${what} failed: ${(error as Error).name}: ${(error as Error).message}`)
    }
  }

  for (const region of regions) {
    const ec2 = new EC2Client(config(region))

    await record(
      region,
      'ec2-describe-instances',
      'EC2 instance(s)',
      () => allPages(paginateDescribeInstances({ client: ec2 }, {})),
      (pages) => pages.reduce((n, page) => n + (page.Reservations ?? []).flatMap((r) => r.Instances ?? []).length, 0)
    )
    await record(
      region,
      'ec2-describe-volumes',
      'EBS volume(s)',
      () => allPages(paginateDescribeVolumes({ client: ec2 }, {})),
      (pages) => pages.reduce((n, page) => n + (page.Volumes ?? []).length, 0)
    )
    // Not paginated: one response.
    await record(
      region,
      'ec2-describe-addresses',
      'Elastic IP(s)',
      () => ec2.send(new DescribeAddressesCommand({})),
      (response) => (response.Addresses ?? []).length
    )
    await record(
      region,
      'ec2-describe-nat-gateways',
      'NAT gateway(s)',
      () => allPages(paginateDescribeNatGateways({ client: ec2 }, {})),
      (pages) => pages.reduce((n, page) => n + (page.NatGateways ?? []).length, 0)
    )
    await record(
      region,
      'rds-describe-db-instances',
      'RDS instance(s)',
      () => allPages(paginateDescribeDBInstances({ client: new RDSClient(config(region)) }, {})),
      (pages) => pages.reduce((n, page) => n + (page.DBInstances ?? []).length, 0)
    )
    await record(
      region,
      'elbv2-describe-load-balancers',
      'ALB/NLB/GWLB load balancer(s)',
      () => allPages(paginateV2LoadBalancers({ client: new ElasticLoadBalancingV2Client(config(region)) }, {})),
      (pages) => pages.reduce((n, page) => n + (page.LoadBalancers ?? []).length, 0)
    )
    await record(
      region,
      'elb-describe-load-balancers',
      'classic load balancer(s)',
      () => allPages(paginateClassicLoadBalancers({ client: new ElasticLoadBalancingClient(config(region)) }, {})),
      (pages) => pages.reduce((n, page) => n + (page.LoadBalancerDescriptions ?? []).length, 0)
    )
    // The list, then each endpoint and each distinct config, in one file.
    await record(
      region,
      'sagemaker-endpoints',
      'SageMaker endpoint(s)',
      async () => {
        const sagemaker = new SageMakerClient(config(region))
        const list = await allPages(paginateListEndpoints({ client: sagemaker }, {}))
        const names = list.flatMap((page) => page.Endpoints ?? []).flatMap((e) => (e.EndpointName ? [e.EndpointName] : []))
        const endpoints = []
        for (const name of names) {
          endpoints.push(await sagemaker.send(new DescribeEndpointCommand({ EndpointName: name })))
        }
        const configNames = [...new Set(endpoints.flatMap((e) => (e.EndpointConfigName ? [e.EndpointConfigName] : [])))]
        const configs = []
        for (const name of configNames) {
          configs.push(await sagemaker.send(new DescribeEndpointConfigCommand({ EndpointConfigName: name })))
        }
        return { list, endpoints, configs }
      },
      (data) => data.endpoints.length
    )
  }

  console.log(`\nWrote ${written.length} file(s):`)
  for (const name of written) console.log(`  ${join(SANITISED_DIR, name)}`)
  console.log(`\nExact copies are in ${RAW_DIR} (ignored by git). Do not commit them.`)
  console.log(`Read every file in ${SANITISED_DIR} before committing: the sanitiser is a best effort.`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error)
  process.exitCode = 1
})
