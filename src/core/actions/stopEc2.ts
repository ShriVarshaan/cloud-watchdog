// Stopping one EC2 instance: how to look at it, what forbids stopping it,
// what stopping it means, and the stop call itself. The decisions about
// tokens, confirmation and re-checking are in guard.ts.
//
// The stop is a plain StopInstances for one instance id: no Force (which
// skips the operating system's shutdown) and no Hibernate.

import { DescribeInstancesCommand, DescribeInstanceTypesCommand, EC2Client, StopInstancesCommand, type Instance } from '@aws-sdk/client-ec2'
import { hasErrorName } from '../aws/errors'
import { tagValue } from '../scanners/tags'
import type { ActionDriver, Facts } from './guard'

const ASG_TAG = 'aws:autoscaling:groupName'

/** An address AWS lends for as long as the instance runs is owned by "amazon"; an Elastic IP by the account. */
function publicIpKind(instance: Instance): 'none' | 'auto' | 'elastic' {
  const associations = (instance.NetworkInterfaces ?? []).flatMap((eni) => (eni.Association?.PublicIp ? [eni.Association] : []))
  if (associations.some((association) => association.IpOwnerId === 'amazon')) return 'auto'
  if (associations.length > 0) return 'elastic'
  // An address with no owner on record: assume the kind that changes.
  return instance.PublicIpAddress ? 'auto' : 'none'
}

/** Whether the instance type comes with instance-store disks. null = AWS did not say. */
async function hasInstanceStore(client: EC2Client, instanceType: NonNullable<Instance['InstanceType']>): Promise<boolean | null> {
  const response = await client.send(new DescribeInstanceTypesCommand({ InstanceTypes: [instanceType] }))
  const info = response.InstanceTypes?.find((candidate) => candidate.InstanceType === instanceType)
  return info?.InstanceStorageSupported ?? null
}

export const stopEc2: ActionDriver = {
  action: 'stop-ec2',
  kind: 'ec2-instance',
  done: 'AWS is stopping the instance. It takes a minute or so; the next scan shows it as stopped.',

  async observe(clients, region, id): Promise<Facts | null> {
    const client = clients.get(EC2Client, region)
    let instance: Instance | undefined
    try {
      const response = await client.send(new DescribeInstancesCommand({ InstanceIds: [id] }))
      instance = (response.Reservations ?? []).flatMap((reservation) => reservation.Instances ?? []).find((found) => found.InstanceId === id)
    } catch (error) {
      if (hasErrorName(error, 'InvalidInstanceID.NotFound')) return null
      throw error
    }
    if (!instance) return null

    const state = instance.State?.Name ?? 'unknown'
    return {
      state,
      instanceType: instance.InstanceType ?? null,
      autoScalingGroup: tagValue(instance.Tags, ASG_TAG),
      // AWS leaves this out for ordinary on-demand instances.
      lifecycle: instance.InstanceLifecycle ?? null,
      rootDeviceType: instance.RootDeviceType ?? null,
      // Only matters for an instance that could be stopped at all.
      instanceStore: state === 'running' && instance.InstanceType ? await hasInstanceStore(client, instance.InstanceType) : null,
      publicIp: publicIpKind(instance)
    }
  },

  blockers(facts) {
    if (facts.state !== 'running') return [`It is ${facts.state}, not running.`]

    const found: string[] = []
    if (facts.autoScalingGroup) {
      found.push(`It belongs to the Auto Scaling group "${facts.autoScalingGroup}", which would replace it with a new instance.`)
    }
    if (facts.lifecycle) {
      found.push(`It is a ${facts.lifecycle} instance, not an ordinary on-demand one. Stopping those works differently.`)
    }
    if (facts.rootDeviceType === 'instance-store') {
      found.push('Its root disk is an instance-store disk. Such an instance cannot be stopped, only terminated.')
    } else if (facts.instanceStore === true) {
      found.push(`Its type (${facts.instanceType}) comes with instance-store disks. Everything on them is lost when it stops.`)
    } else if (facts.instanceStore !== false) {
      found.push('AWS did not say whether its instance type has instance-store disks, whose contents are lost on a stop.')
    }
    return found
  },

  consequences(facts) {
    return [
      'Its disks (EBS volumes) keep billing while it is stopped.',
      ...(facts.publicIp === 'auto' ? ['Its public IP address is given back. It gets a different one when it is started again.'] : []),
      ...(facts.publicIp === 'elastic' ? ['Its Elastic IP stays with it and keeps billing.'] : []),
      'Anything held only in memory is lost, as when a computer is shut down.',
      'Cloud Watchdog cannot start it again. You start it from the AWS console or with the AWS CLI.'
    ]
  },

  async checkPermission(clients, region, id) {
    try {
      await clients.get(EC2Client, region).send(new StopInstancesCommand({ InstanceIds: [id], DryRun: true }))
    } catch (error) {
      // What AWS answers to a dry run that would have been allowed.
      if (hasErrorName(error, 'DryRunOperation')) return null
      if (hasErrorName(error, 'UnauthorizedOperation')) {
        return 'This profile is not allowed to stop EC2 instances. Attach the policy in iam/cloud-watchdog-actions.json to it.'
      }
      throw error
    }
    return null
  },

  async stop(clients, region, id) {
    await clients.get(EC2Client, region).send(new StopInstancesCommand({ InstanceIds: [id] }))
  }
}
