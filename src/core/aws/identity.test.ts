import { DescribeRegionsCommand, EC2Client } from '@aws-sdk/client-ec2'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, describe, expect, it } from 'vitest'
import { createClientFactory, HOME_REGION } from './clients'
import { classifyAwsError } from './errors'
import { getIdentity } from './identity'
import { listEnabledRegions } from './regions'

const sts = mockClient(STSClient)
const ec2 = mockClient(EC2Client)

afterEach(() => {
  sts.reset()
  ec2.reset()
})

const clients = () =>
  createClientFactory({
    profile: 'hackathon',
    credentials: async () => ({ accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'fake' })
  })

describe('getIdentity', () => {
  it('returns the account, ARN and profile', async () => {
    sts.on(GetCallerIdentityCommand).resolves({
      Account: '111122223333',
      Arn: 'arn:aws:iam::111122223333:user/watchdog',
      UserId: 'AIDAFAKE'
    })
    expect(await getIdentity(clients())).toEqual({
      accountId: '111122223333',
      arn: 'arn:aws:iam::111122223333:user/watchdog',
      profile: 'hackathon'
    })
  })

  it('asks STS in the home region', async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: '111122223333', Arn: 'arn:aws:iam::111122223333:root' })
    const factory = clients()
    await getIdentity(factory)
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(1)
    expect(await factory.get(STSClient, HOME_REGION).config.region()).toBe('us-east-1')
  })

  it('rejects a response without an account id rather than guessing', async () => {
    sts.on(GetCallerIdentityCommand).resolves({})
    await expect(getIdentity(clients())).rejects.toThrow(/account/i)
  })

  it('lets an expired token surface as a classifiable error', async () => {
    sts
      .on(GetCallerIdentityCommand)
      .rejects(Object.assign(new Error('The security token included in the request is expired'), { name: 'ExpiredToken' }))
    const error = await getIdentity(clients()).catch((e: unknown) => e)
    expect(classifyAwsError(error).code).toBe('auth-expired')
  })
})

describe('listEnabledRegions', () => {
  it('returns the enabled regions, sorted', async () => {
    ec2.on(DescribeRegionsCommand).resolves({
      Regions: [
        { RegionName: 'us-east-1', OptInStatus: 'opt-in-not-required' },
        { RegionName: 'af-south-1', OptInStatus: 'opted-in' },
        { RegionName: 'eu-west-1', OptInStatus: 'opt-in-not-required' }
      ]
    })
    expect(await listEnabledRegions(clients())).toEqual(['af-south-1', 'eu-west-1', 'us-east-1'])
  })

  it('asks only for regions enabled for the account', async () => {
    ec2.on(DescribeRegionsCommand).resolves({ Regions: [{ RegionName: 'us-east-1' }] })
    await listEnabledRegions(clients())
    const [call] = ec2.commandCalls(DescribeRegionsCommand)
    expect(call?.args[0].input).toEqual({ AllRegions: false })
  })

  it('drops regions that are not opted in and entries without a name', async () => {
    ec2.on(DescribeRegionsCommand).resolves({
      Regions: [
        { RegionName: 'us-east-1', OptInStatus: 'opt-in-not-required' },
        { RegionName: 'me-south-1', OptInStatus: 'not-opted-in' },
        { OptInStatus: 'opted-in' }
      ]
    })
    expect(await listEnabledRegions(clients())).toEqual(['us-east-1'])
  })

  it('throws when AWS returns no regions at all', async () => {
    ec2.on(DescribeRegionsCommand).resolves({ Regions: [] })
    await expect(listEnabledRegions(clients())).rejects.toThrow(/no enabled regions/i)
  })

  it('lets access denied surface as a classifiable error', async () => {
    ec2
      .on(DescribeRegionsCommand)
      .rejects(Object.assign(new Error('You are not authorized'), { name: 'UnauthorizedOperation' }))
    const error = await listEnabledRegions(clients()).catch((e: unknown) => e)
    expect(classifyAwsError(error).code).toBe('access-denied')
  })
})
