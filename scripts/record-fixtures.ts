// Records real AWS responses as test fixtures. You run this by hand, once,
// against your own account. Automated tests never call AWS.
//
//   npm run record-fixtures -- --profile <name> [--regions eu-west-1,us-east-1]
//
// It makes read-only calls only (the same ones the scanners make):
//   sts:GetCallerIdentity, ec2:DescribeRegions, ec2:DescribeInstances,
//   rds:DescribeDBInstances
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
import { DescribeRegionsCommand, EC2Client, paginateDescribeInstances } from '@aws-sdk/client-ec2'
import { paginateDescribeDBInstances, RDSClient } from '@aws-sdk/client-rds'
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

  for (const region of regions) {
    try {
      const pages = await allPages(paginateDescribeInstances({ client: new EC2Client(config(region)) }, {}))
      const count = pages.reduce((n, page) => n + (page.Reservations ?? []).flatMap((r) => r.Instances ?? []).length, 0)
      if (count > 0) save(`ec2-describe-instances.${region}`, pages)
      console.log(`${region}: ${count} EC2 instance(s)`)
    } catch (error) {
      console.error(`${region}: ec2:DescribeInstances failed: ${(error as Error).name}: ${(error as Error).message}`)
    }

    try {
      const pages = await allPages(paginateDescribeDBInstances({ client: new RDSClient(config(region)) }, {}))
      const count = pages.reduce((n, page) => n + (page.DBInstances ?? []).length, 0)
      if (count > 0) save(`rds-describe-db-instances.${region}`, pages)
      console.log(`${region}: ${count} RDS instance(s)`)
    } catch (error) {
      console.error(`${region}: rds:DescribeDBInstances failed: ${(error as Error).name}: ${(error as Error).message}`)
    }
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
