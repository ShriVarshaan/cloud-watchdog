import { DescribeNatGatewaysCommand, EC2Client } from '@aws-sdk/client-ec2'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, describe, expect, it } from 'vitest'
import {
  deleted,
  deleting,
  failed,
  privatePending,
  publicAvailable,
  regionalAvailable
} from '../../../tests/fixtures/natGateways'
import { createClientFactory } from '../aws/clients'
import { classifyAwsError } from '../aws/errors'
import type { ScanContext } from '../scan/scanner'
import { natGateways } from './natGateways'

const ec2 = mockClient(EC2Client)
afterEach(() => ec2.reset())

const clients = createClientFactory({
  profile: 'hackathon',
  credentials: async () => ({ accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'fake' })
})

function ctx(region = 'eu-west-1', signal: AbortSignal = new AbortController().signal): ScanContext {
  return { accountId: '111122223333', region, clients, signal }
}

describe('natGateways scanner', () => {
  it('maps a public NAT gateway to a resource', async () => {
    ec2.on(DescribeNatGatewaysCommand).resolves({ NatGateways: [publicAvailable] })

    expect(await natGateways.scan(ctx())).toEqual([
      {
        key: '111122223333:nat-gateway:eu-west-1:nat-0aaa1111bbbb22223',
        kind: 'nat-gateway',
        region: 'eu-west-1',
        id: 'nat-0aaa1111bbbb22223',
        name: 'demo-nat',
        state: 'available',
        createdAt: '2026-11-07T16:00:00.000Z',
        attrs: { connectivityType: 'public', availabilityMode: 'zonal' }
      }
    ])
  })

  it('maps a private gateway being created, defaulting the availability mode to zonal', async () => {
    ec2.on(DescribeNatGatewaysCommand).resolves({ NatGateways: [privatePending] })
    const [found] = await natGateways.scan(ctx())

    expect(found).not.toHaveProperty('name')
    expect(found).toMatchObject({
      state: 'pending',
      attrs: { connectivityType: 'private', availabilityMode: 'zonal' }
    })
  })

  it('records a regional gateway and ignores an empty Name tag', async () => {
    ec2.on(DescribeNatGatewaysCommand).resolves({ NatGateways: [regionalAvailable] })
    const [found] = await natGateways.scan(ctx('us-east-1'))

    expect(found).not.toHaveProperty('name')
    expect(found).toMatchObject({
      key: '111122223333:nat-gateway:us-east-1:nat-0eee5555ffff66667',
      attrs: { availabilityMode: 'regional' }
    })
  })

  it('keeps a gateway that is being deleted, because it still bills', async () => {
    ec2.on(DescribeNatGatewaysCommand).resolves({ NatGateways: [deleting] })
    expect(await natGateways.scan(ctx())).toMatchObject([{ id: 'nat-0111222233334444a', state: 'deleting' }])
  })

  it('leaves out deleted and failed gateways, which cost nothing', async () => {
    ec2.on(DescribeNatGatewaysCommand).resolves({ NatGateways: [deleted, failed, publicAvailable] })
    expect((await natGateways.scan(ctx())).map((r) => r.id)).toEqual(['nat-0aaa1111bbbb22223'])
  })

  it('records null for a connectivity type AWS leaves out', async () => {
    ec2.on(DescribeNatGatewaysCommand).resolves({ NatGateways: [{ NatGatewayId: 'nat-0abcdef0123456789' }] })
    const [found] = await natGateways.scan(ctx())
    expect(found).toMatchObject({ state: 'unknown', attrs: { connectivityType: null } })
    expect(found).not.toHaveProperty('createdAt')
  })

  it('skips an entry that has no gateway id', async () => {
    ec2.on(DescribeNatGatewaysCommand).resolves({ NatGateways: [{ State: 'available' }] })
    expect(await natGateways.scan(ctx())).toEqual([])
  })

  it('reads every page', async () => {
    ec2
      .on(DescribeNatGatewaysCommand)
      .resolves({ NatGateways: [publicAvailable, privatePending], NextToken: 'page-2' })
      .on(DescribeNatGatewaysCommand, { NextToken: 'page-2' })
      .resolves({ NatGateways: [regionalAvailable] })

    const found = await natGateways.scan(ctx())

    expect(found.map((r) => r.id)).toEqual(['nat-0aaa1111bbbb22223', 'nat-0ccc3333dddd44445', 'nat-0eee5555ffff66667'])
    expect(ec2.commandCalls(DescribeNatGatewaysCommand)).toHaveLength(2)
  })

  it('returns nothing for a region with no NAT gateways', async () => {
    ec2.on(DescribeNatGatewaysCommand).resolves({ NatGateways: [] })
    expect(await natGateways.scan(ctx())).toEqual([])
  })

  it('calls the region it was asked to scan, and passes the abort signal on', async () => {
    ec2.on(DescribeNatGatewaysCommand).resolves({ NatGateways: [] })
    const signal = new AbortController().signal
    await natGateways.scan(ctx('ap-south-1', signal))

    const [call] = ec2.commandCalls(DescribeNatGatewaysCommand)
    expect(call?.thisValue).toBe(clients.get(EC2Client, 'ap-south-1'))
    expect((call?.args as unknown[])[1]).toMatchObject({ abortSignal: signal })
  })

  it('does not catch errors: the engine classifies them', async () => {
    ec2.on(DescribeNatGatewaysCommand).rejects(Object.assign(new Error('nope'), { name: 'UnauthorizedOperation' }))
    const error = await natGateways.scan(ctx()).catch((e: unknown) => e)
    expect(classifyAwsError(error).code).toBe('access-denied')
  })

  it('declares its limiter bucket, kind and IAM action', () => {
    expect(natGateways).toMatchObject({
      kind: 'nat-gateway',
      service: 'ec2',
      requiredActions: ['ec2:DescribeNatGateways']
    })
  })
})
