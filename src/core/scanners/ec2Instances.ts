// EC2 instances in one region. This is the reference scanner: the others (M4)
// follow the same three steps.
//
//   1. call the SDK paginator, passing the abort signal
//   2. map each item to a `Resource`, keeping only what pricing and rules need
//   3. let every error escape; the scan engine classifies it
//
// Tags are not stored, except the Name and the Auto Scaling group name.

import { EC2Client, paginateDescribeInstances, type Instance } from '@aws-sdk/client-ec2'
import { resourceKey, type Resource } from '../../shared/types'
import type { ScanContext, Scanner } from '../scan/scanner'
import { nameFromTags, tagValue } from './tags'

const ASG_TAG = 'aws:autoscaling:groupName'

function toResource(instance: Instance, ctx: ScanContext): Resource | null {
  const id = instance.InstanceId
  const state = instance.State?.Name
  // A terminated instance stays listed for about an hour. It costs nothing.
  if (!id || state === 'terminated') return null

  return {
    key: resourceKey(ctx.accountId, 'ec2-instance', ctx.region, id),
    kind: 'ec2-instance',
    region: ctx.region,
    id,
    ...nameFromTags(instance.Tags),
    state: state ?? 'unknown',
    // The time of the latest start, not of creation: it is what "running for N hours" needs.
    ...(instance.LaunchTime ? { createdAt: instance.LaunchTime.toISOString() } : {}),
    attrs: {
      instanceType: instance.InstanceType ?? null,
      // PlatformDetails and UsageOperation are the billing view of the operating system.
      platformDetails: instance.PlatformDetails ?? null,
      usageOperation: instance.UsageOperation ?? null,
      tenancy: instance.Placement?.Tenancy ?? null,
      // AWS leaves InstanceLifecycle out for ordinary on-demand instances.
      lifecycle: instance.InstanceLifecycle ?? 'on-demand',
      publicIp: instance.PublicIpAddress ?? null,
      rootDeviceType: instance.RootDeviceType ?? null,
      autoScalingGroup: tagValue(instance.Tags, ASG_TAG)
    }
  }
}

export const ec2Instances: Scanner = {
  kind: 'ec2-instance',
  service: 'ec2',
  requiredActions: ['ec2:DescribeInstances'],

  async scan(ctx) {
    const client = ctx.clients.get(EC2Client, ctx.region)
    const resources: Resource[] = []
    for await (const page of paginateDescribeInstances({ client }, {}, { abortSignal: ctx.signal })) {
      for (const reservation of page.Reservations ?? []) {
        for (const instance of reservation.Instances ?? []) {
          const resource = toResource(instance, ctx)
          if (resource) resources.push(resource)
        }
      }
    }
    return resources
  }
}
