import { DescribeAddressesCommand, EC2Client } from '@aws-sdk/client-ec2'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, describe, expect, it } from 'vitest'
import { associatedToInstance, byoip, onNatGatewayEni, unassociated } from '../../../tests/fixtures/elasticIps'
import { createClientFactory } from '../aws/clients'
import { classifyAwsError } from '../aws/errors'
import type { ScanContext } from '../scan/scanner'
import { elasticIps } from './elasticIps'

const ec2 = mockClient(EC2Client)
afterEach(() => ec2.reset())

const clients = createClientFactory({
  profile: 'hackathon',
  credentials: async () => ({ accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'fake' })
})

function ctx(region = 'eu-west-1', signal: AbortSignal = new AbortController().signal): ScanContext {
  return { accountId: '111122223333', region, clients, signal }
}

describe('elasticIps scanner', () => {
  it('maps an address attached to an instance to a resource', async () => {
    ec2.on(DescribeAddressesCommand).resolves({ Addresses: [associatedToInstance] })

    expect(await elasticIps.scan(ctx())).toEqual([
      {
        key: '111122223333:elastic-ip:eu-west-1:eipalloc-0aaa1111bbbb22223',
        kind: 'elastic-ip',
        region: 'eu-west-1',
        id: 'eipalloc-0aaa1111bbbb22223',
        name: 'demo-web-ip',
        state: 'associated',
        attrs: {
          publicIp: '203.0.113.20',
          associatedInstanceId: 'i-0aaa1111bbbb22223',
          networkInterfaceId: 'eni-0aaa1111bbbb22223',
          publicIpv4Pool: 'amazon'
        }
      }
    ])
  })

  it('marks an address attached to nothing as unassociated', async () => {
    ec2.on(DescribeAddressesCommand).resolves({ Addresses: [unassociated] })
    const [found] = await elasticIps.scan(ctx())

    expect(found).not.toHaveProperty('name')
    expect(found).not.toHaveProperty('createdAt') // DescribeAddresses gives no allocation time
    expect(found).toMatchObject({
      state: 'unassociated',
      attrs: { publicIp: '203.0.113.21', associatedInstanceId: null, networkInterfaceId: null }
    })
  })

  it('counts an address on a network interface without an instance as associated', async () => {
    ec2.on(DescribeAddressesCommand).resolves({ Addresses: [onNatGatewayEni] })
    const [found] = await elasticIps.scan(ctx('us-east-1'))

    expect(found).not.toHaveProperty('name') // an empty Name tag is no name
    expect(found).toMatchObject({
      key: '111122223333:elastic-ip:us-east-1:eipalloc-0eee5555ffff66667',
      state: 'associated',
      attrs: { associatedInstanceId: null, networkInterfaceId: 'eni-0eee5555ffff66667' }
    })
  })

  it('records the address pool, so pricing can tell BYOIP apart', async () => {
    ec2.on(DescribeAddressesCommand).resolves({ Addresses: [byoip] })
    const [found] = await elasticIps.scan(ctx())
    expect(found?.attrs.publicIpv4Pool).toBe('ipv4pool-ec2-0111222233334444a')
  })

  it('uses the public IP as the id when there is no allocation id', async () => {
    ec2.on(DescribeAddressesCommand).resolves({ Addresses: [{ PublicIp: '203.0.113.30', Domain: 'standard' }] })
    const [found] = await elasticIps.scan(ctx())
    expect(found).toMatchObject({ id: '203.0.113.30', state: 'unassociated', attrs: { publicIpv4Pool: null } })
  })

  it('skips an entry with neither an allocation id nor a public IP', async () => {
    ec2.on(DescribeAddressesCommand).resolves({ Addresses: [{ Domain: 'vpc' }] })
    expect(await elasticIps.scan(ctx())).toEqual([])
  })

  it('makes one call: DescribeAddresses is not paginated', async () => {
    ec2.on(DescribeAddressesCommand).resolves({ Addresses: [associatedToInstance, unassociated, byoip] })

    const found = await elasticIps.scan(ctx())

    expect(found.map((r) => r.id)).toEqual([
      'eipalloc-0aaa1111bbbb22223',
      'eipalloc-0ccc3333dddd44445',
      'eipalloc-0111222233334444a'
    ])
    expect(ec2.commandCalls(DescribeAddressesCommand)).toHaveLength(1)
  })

  it('returns nothing for a region with no addresses', async () => {
    ec2.on(DescribeAddressesCommand).resolves({})
    expect(await elasticIps.scan(ctx())).toEqual([])
  })

  it('calls the region it was asked to scan, and passes the abort signal on', async () => {
    ec2.on(DescribeAddressesCommand).resolves({ Addresses: [] })
    const signal = new AbortController().signal
    await elasticIps.scan(ctx('ap-south-1', signal))

    const [call] = ec2.commandCalls(DescribeAddressesCommand)
    expect(call?.thisValue).toBe(clients.get(EC2Client, 'ap-south-1'))
    expect((call?.args as unknown[])[1]).toMatchObject({ abortSignal: signal })
  })

  it('does not catch errors: the engine classifies them', async () => {
    ec2.on(DescribeAddressesCommand).rejects(Object.assign(new Error('nope'), { name: 'UnauthorizedOperation' }))
    const error = await elasticIps.scan(ctx()).catch((e: unknown) => e)
    expect(classifyAwsError(error).code).toBe('access-denied')
  })

  it('declares its limiter bucket, kind and IAM action', () => {
    expect(elasticIps).toMatchObject({
      kind: 'elastic-ip',
      service: 'ec2',
      requiredActions: ['ec2:DescribeAddresses']
    })
  })
})
