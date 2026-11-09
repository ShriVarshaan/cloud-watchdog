// The regions a scan covers: those enabled for the account. Regions the user
// never opted in to cannot hold resources and reject every call, so they are
// left out. Needs ec2:DescribeRegions.

import { DescribeRegionsCommand, EC2Client } from '@aws-sdk/client-ec2'
import { HOME_REGION, type ClientFactory } from './clients'

export async function listEnabledRegions(clients: ClientFactory, signal?: AbortSignal): Promise<string[]> {
  const response = await clients
    .get(EC2Client, HOME_REGION)
    // AllRegions: false returns only regions enabled for this account.
    .send(new DescribeRegionsCommand({ AllRegions: false }), signal ? { abortSignal: signal } : {})

  const regions = (response.Regions ?? [])
    .filter((region) => region.OptInStatus !== 'not-opted-in')
    .map((region) => region.RegionName)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
    .sort()

  if (regions.length === 0) throw new Error('AWS returned no enabled regions for this account.')
  return regions
}
