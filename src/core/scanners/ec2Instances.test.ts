import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, describe, expect, it } from 'vitest'
import { reservation, runningLinux, spotGpuInAsg, stoppedWindows, terminated } from '../../../tests/fixtures/ec2Instances'
import { createClientFactory } from '../aws/clients'
import { classifyAwsError } from '../aws/errors'
import type { ScanContext } from '../scan/scanner'
import { ec2Instances } from './ec2Instances'

const ec2 = mockClient(EC2Client)
afterEach(() => ec2.reset())

const clients = createClientFactory({
  profile: 'hackathon',
  credentials: async () => ({ accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'fake' })
})

function ctx(region = 'eu-west-1', signal: AbortSignal = new AbortController().signal): ScanContext {
  return { accountId: '111122223333', region, clients, signal }
}

describe('ec2Instances scanner', () => {
  it('maps a running instance to a resource', async () => {
    ec2.on(DescribeInstancesCommand).resolves({ Reservations: [reservation(runningLinux)] })

    expect(await ec2Instances.scan(ctx())).toEqual([
      {
        key: '111122223333:ec2-instance:eu-west-1:i-0aaa1111bbbb22223',
        kind: 'ec2-instance',
        region: 'eu-west-1',
        id: 'i-0aaa1111bbbb22223',
        name: 'demo-web',
        state: 'running',
        createdAt: '2026-11-08T14:30:00.000Z',
        attrs: {
          instanceType: 't3.micro',
          platformDetails: 'Linux/UNIX',
          usageOperation: 'RunInstances',
          tenancy: 'default',
          lifecycle: 'on-demand',
          publicIp: '203.0.113.10',
          rootDeviceType: 'ebs',
          autoScalingGroup: null
        }
      }
    ])
  })

  it('maps a stopped, untagged, dedicated Windows instance', async () => {
    ec2.on(DescribeInstancesCommand).resolves({ Reservations: [reservation(stoppedWindows)] })
    const [found] = await ec2Instances.scan(ctx())

    expect(found).not.toHaveProperty('name')
    expect(found).toMatchObject({
      id: 'i-0ccc3333dddd44445',
      state: 'stopped',
      attrs: {
        instanceType: 'm5.large',
        platformDetails: 'Windows',
        usageOperation: 'RunInstances:0002',
        tenancy: 'dedicated',
        lifecycle: 'on-demand',
        publicIp: null,
        rootDeviceType: 'ebs',
        autoScalingGroup: null
      }
    })
  })

  it('records spot lifecycle, the Auto Scaling group and an instance-store root', async () => {
    ec2.on(DescribeInstancesCommand).resolves({ Reservations: [reservation(spotGpuInAsg)] })
    const [found] = await ec2Instances.scan(ctx('us-east-1'))

    expect(found).not.toHaveProperty('name') // an empty Name tag is no name
    expect(found).toMatchObject({
      key: '111122223333:ec2-instance:us-east-1:i-0eee5555ffff66667',
      region: 'us-east-1',
      attrs: {
        instanceType: 'g5.xlarge',
        lifecycle: 'spot',
        rootDeviceType: 'instance-store',
        autoScalingGroup: 'training-fleet'
      }
    })
  })

  it('leaves out terminated instances', async () => {
    ec2.on(DescribeInstancesCommand).resolves({ Reservations: [reservation(terminated, runningLinux)] })
    expect((await ec2Instances.scan(ctx())).map((r) => r.id)).toEqual(['i-0aaa1111bbbb22223'])
  })

  it('reads every page and every reservation', async () => {
    ec2
      .on(DescribeInstancesCommand)
      .resolves({ Reservations: [reservation(runningLinux), reservation(stoppedWindows)], NextToken: 'page-2' })
      .on(DescribeInstancesCommand, { NextToken: 'page-2' })
      .resolves({ Reservations: [reservation(spotGpuInAsg)] })

    const found = await ec2Instances.scan(ctx())

    expect(found.map((r) => r.id)).toEqual(['i-0aaa1111bbbb22223', 'i-0ccc3333dddd44445', 'i-0eee5555ffff66667'])
    expect(ec2.commandCalls(DescribeInstancesCommand)).toHaveLength(2)
  })

  it('returns nothing for a region with no instances', async () => {
    ec2.on(DescribeInstancesCommand).resolves({ Reservations: [] })
    expect(await ec2Instances.scan(ctx())).toEqual([])
  })

  it('skips an entry that has no instance id', async () => {
    ec2.on(DescribeInstancesCommand).resolves({ Reservations: [reservation({ State: { Name: 'running' } })] })
    expect(await ec2Instances.scan(ctx())).toEqual([])
  })

  it('calls the region it was asked to scan, and passes the abort signal on', async () => {
    ec2.on(DescribeInstancesCommand).resolves({ Reservations: [] })
    const signal = new AbortController().signal
    await ec2Instances.scan(ctx('ap-south-1', signal))

    const [call] = ec2.commandCalls(DescribeInstancesCommand)
    expect(call?.thisValue).toBe(clients.get(EC2Client, 'ap-south-1'))
    expect((call?.args as unknown[])[1]).toMatchObject({ abortSignal: signal })
  })

  it('does not catch errors: the engine classifies them', async () => {
    ec2.on(DescribeInstancesCommand).rejects(Object.assign(new Error('nope'), { name: 'UnauthorizedOperation' }))
    const error = await ec2Instances.scan(ctx()).catch((e: unknown) => e)
    expect(classifyAwsError(error).code).toBe('access-denied')
  })

  it('declares its limiter bucket and kind', () => {
    expect(ec2Instances).toMatchObject({ kind: 'ec2-instance', service: 'ec2' })
  })
})
