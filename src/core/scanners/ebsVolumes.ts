// EBS volumes in one region. Same three steps as ec2Instances.ts.
//
// A volume bills for its provisioned size whether or not it is attached, and
// whether or not its instance is running, so every volume that exists is kept.

import { EC2Client, paginateDescribeVolumes, type Volume } from '@aws-sdk/client-ec2'
import { resourceKey, type Resource } from '../../shared/types'
import type { ScanContext, Scanner } from '../scan/scanner'
import { nameFromTags } from './tags'

function toResource(volume: Volume, ctx: ScanContext): Resource | null {
  const id = volume.VolumeId
  const state = volume.State
  // A deleted volume can stay listed for a short while. It costs nothing.
  if (!id || state === 'deleted') return null

  const attachments = volume.Attachments ?? []
  return {
    key: resourceKey(ctx.accountId, 'ebs-volume', ctx.region, id),
    kind: 'ebs-volume',
    region: ctx.region,
    id,
    ...nameFromTags(volume.Tags),
    state: state ?? 'unknown',
    ...(volume.CreateTime ? { createdAt: volume.CreateTime.toISOString() } : {}),
    attrs: {
      volumeType: volume.VolumeType ?? null,
      sizeGb: volume.Size ?? null,
      // Provisioned for io1, io2 and gp3; a derived baseline for gp2; absent for standard.
      iops: volume.Iops ?? null,
      // gp3 only.
      throughputMibps: volume.Throughput ?? null,
      attachedInstanceId: attachments[0]?.InstanceId ?? null,
      // More than one only with io1/io2 Multi-Attach.
      attachmentCount: attachments.length
    }
  }
}

export const ebsVolumes: Scanner = {
  kind: 'ebs-volume',
  service: 'ec2',
  requiredActions: ['ec2:DescribeVolumes'],

  async scan(ctx) {
    const client = ctx.clients.get(EC2Client, ctx.region)
    const resources: Resource[] = []
    for await (const page of paginateDescribeVolumes({ client }, {}, { abortSignal: ctx.signal })) {
      for (const volume of page.Volumes ?? []) {
        const resource = toResource(volume, ctx)
        if (resource) resources.push(resource)
      }
    }
    return resources
  }
}
