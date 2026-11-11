import {
  DescribeInstancesCommand,
  DescribeInstanceTypesCommand,
  EC2Client,
  StopInstancesCommand,
  type Instance
} from '@aws-sdk/client-ec2'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, describe, expect, it } from 'vitest'
import { createClientFactory } from '../aws/clients'
import { stopEc2 } from './stopEc2'

const ec2 = mockClient(EC2Client)
afterEach(() => ec2.reset())

const clients = createClientFactory({ profile: 'hackathon', credentials: async () => ({ accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'fake' }) })
const awsError = (name: string, message = name) => Object.assign(new Error(message), { name })

const ordinary: Instance = {
  InstanceId: 'i-1',
  InstanceType: 't3.micro',
  State: { Name: 'running' },
  RootDeviceType: 'ebs',
  PublicIpAddress: '203.0.113.10',
  NetworkInterfaces: [{ Association: { PublicIp: '203.0.113.10', IpOwnerId: 'amazon' } }]
}

function aws(instance: Instance | null, instanceStore: boolean | null = false) {
  ec2.on(DescribeInstancesCommand).resolves({ Reservations: instance ? [{ Instances: [instance] }] : [] })
  ec2.on(DescribeInstanceTypesCommand).resolves({
    InstanceTypes: instanceStore === null ? [] : [{ InstanceType: instance?.InstanceType ?? 't3.micro', InstanceStorageSupported: instanceStore }]
  })
}
const observe = () => stopEc2.observe(clients, 'eu-west-1', 'i-1')
async function blockers(instance: Instance, instanceStore: boolean | null = false): Promise<string[]> {
  aws(instance, instanceStore)
  return stopEc2.blockers((await observe())!)
}

describe('looking at the instance', () => {
  it('asks AWS about that one instance, in its region', async () => {
    aws(ordinary)
    const facts = await observe()
    expect(facts).toEqual({
      state: 'running',
      instanceType: 't3.micro',
      autoScalingGroup: null,
      lifecycle: null,
      rootDeviceType: 'ebs',
      instanceStore: false,
      publicIp: 'auto'
    })
    expect(ec2.commandCalls(DescribeInstancesCommand).map((call) => call.args[0].input)).toEqual([{ InstanceIds: ['i-1'] }])
    expect(ec2.commandCalls(DescribeInstanceTypesCommand).map((call) => call.args[0].input)).toEqual([{ InstanceTypes: ['t3.micro'] }])
    expect(await clients.get(EC2Client, 'eu-west-1').config.region()).toBe('eu-west-1')
  })

  it('reports an instance AWS does not know as gone', async () => {
    ec2.on(DescribeInstancesCommand).rejects(awsError('InvalidInstanceID.NotFound'))
    expect(await observe()).toBeNull()
  })

  it('reports an empty answer as gone', async () => {
    aws(null)
    expect(await observe()).toBeNull()
  })

  it('ignores any other instance in the answer', async () => {
    aws({ ...ordinary, InstanceId: 'i-2' })
    expect(await observe()).toBeNull()
  })

  it('lets any other failure escape', async () => {
    ec2.on(DescribeInstancesCommand).rejects(awsError('UnauthorizedOperation'))
    await expect(observe()).rejects.toThrow('UnauthorizedOperation')
  })
})

describe('what blocks stopping an instance', () => {
  it('nothing, for an ordinary running instance', async () => {
    expect(await blockers(ordinary)).toEqual([])
  })

  it.each(['pending', 'stopping', 'stopped', 'shutting-down', 'terminated'] as const)('a state of %s', async (state) => {
    expect(await blockers({ ...ordinary, State: { Name: state } })).toEqual([`It is ${state}, not running.`])
  })

  it('an Auto Scaling group, which would replace it', async () => {
    const found = await blockers({ ...ordinary, Tags: [{ Key: 'aws:autoscaling:groupName', Value: 'web-asg' }] })
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('Auto Scaling group "web-asg"')
  })

  it('being a Spot instance', async () => {
    const found = await blockers({ ...ordinary, InstanceLifecycle: 'spot' })
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('spot')
  })

  it('an instance-store root disk', async () => {
    const found = await blockers({ ...ordinary, RootDeviceType: 'instance-store' })
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('root disk')
  })

  it('instance-store disks, whose data is lost on stop', async () => {
    const found = await blockers({ ...ordinary, InstanceType: 'g4dn.xlarge' }, true)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('g4dn.xlarge')
    expect(found[0]).toContain('lost')
  })

  it('not being able to tell whether it has instance-store disks', async () => {
    expect(await blockers(ordinary, null)).toHaveLength(1)
  })

  it('lists every reason, not just the first', async () => {
    const found = await blockers(
      { ...ordinary, InstanceLifecycle: 'spot', Tags: [{ Key: 'aws:autoscaling:groupName', Value: 'web-asg' }] },
      true
    )
    expect(found).toHaveLength(3)
  })
})

describe('what stopping an instance means', () => {
  const consequences = async (instance: Instance) => {
    aws(instance)
    return stopEc2.consequences((await observe())!).join('\n')
  }

  it('its disks keep billing, and the app cannot start it again', async () => {
    const text = await consequences(ordinary)
    expect(text).toContain('keep billing')
    expect(text).toContain('cannot start it again')
  })

  it('an automatic public address changes', async () => {
    expect(await consequences(ordinary)).toContain('different one')
  })

  it('an Elastic IP stays, and keeps billing', async () => {
    const text = await consequences({
      ...ordinary,
      NetworkInterfaces: [{ Association: { PublicIp: '203.0.113.10', IpOwnerId: '111122223333' } }]
    })
    expect(text).toContain('Elastic IP')
    expect(text).not.toContain('different one')
  })

  it('says nothing about addresses when it has no public one', async () => {
    const { PublicIpAddress: _none, ...rest } = ordinary
    const text = await consequences({ ...rest, NetworkInterfaces: [{}] })
    expect(text).not.toContain('Elastic IP')
    expect(text).not.toContain('different one')
  })
})

describe('checking permission', () => {
  const check = () => stopEc2.checkPermission!(clients, 'eu-west-1', 'i-1')

  it('is a dry run: AWS is asked, nothing is stopped', async () => {
    ec2.on(StopInstancesCommand).rejects(awsError('DryRunOperation', 'Request would have succeeded, but DryRun flag is set.'))
    expect(await check()).toBeNull()
    expect(ec2.commandCalls(StopInstancesCommand).map((call) => call.args[0].input)).toEqual([{ InstanceIds: ['i-1'], DryRun: true }])
  })

  it('names the missing policy when the profile may not stop instances', async () => {
    ec2.on(StopInstancesCommand).rejects(awsError('UnauthorizedOperation'))
    expect(await check()).toContain('iam/cloud-watchdog-actions.json')
  })

  it('lets any other failure escape', async () => {
    ec2.on(StopInstancesCommand).rejects(awsError('RequestLimitExceeded'))
    await expect(check()).rejects.toThrow('RequestLimitExceeded')
  })
})

describe('stopping', () => {
  it('sends exactly one plain stop: no Force, no Hibernate, no other instance', async () => {
    ec2.on(StopInstancesCommand).resolves({})
    await stopEc2.stop(clients, 'eu-west-1', 'i-1')
    expect(ec2.commandCalls(StopInstancesCommand).map((call) => call.args[0].input)).toEqual([{ InstanceIds: ['i-1'] }])
    expect(ec2.calls()).toHaveLength(1)
  })

  it('lets a refusal escape', async () => {
    ec2.on(StopInstancesCommand).rejects(awsError('UnauthorizedOperation'))
    await expect(stopEc2.stop(clients, 'eu-west-1', 'i-1')).rejects.toThrow('UnauthorizedOperation')
  })
})
