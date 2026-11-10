// Hand-written DescribeVolumes data in the shape the SDK returns it, with
// made-up ids. Replace or extend with recorded responses from
// `scripts/record-fixtures.ts` (see tests/fixtures/recorded/).

import type { Volume } from '@aws-sdk/client-ec2'

/** A gp3 root volume attached to an instance, with a Name tag. */
export const gp3Attached: Volume = {
  VolumeId: 'vol-0aaa1111bbbb22223',
  VolumeType: 'gp3',
  Size: 8,
  Iops: 3000,
  Throughput: 125,
  State: 'in-use',
  AvailabilityZone: 'eu-west-1a',
  CreateTime: new Date('2026-11-08T14:30:01.000Z'),
  Encrypted: false,
  SnapshotId: 'snap-0aaa1111bbbb22223',
  MultiAttachEnabled: false,
  Attachments: [
    {
      VolumeId: 'vol-0aaa1111bbbb22223',
      InstanceId: 'i-0aaa1111bbbb22223',
      Device: '/dev/xvda',
      State: 'attached',
      AttachTime: new Date('2026-11-08T14:30:01.000Z'),
      DeleteOnTermination: true
    }
  ],
  Tags: [{ Key: 'Name', Value: 'demo-web-root' }]
}

/** A provisioned-IOPS volume left behind after its instance was terminated. */
export const io2Unattached: Volume = {
  VolumeId: 'vol-0ccc3333dddd44445',
  VolumeType: 'io2',
  Size: 500,
  Iops: 16000,
  State: 'available',
  AvailabilityZone: 'eu-west-1b',
  CreateTime: new Date('2026-10-20T10:00:00.000Z'),
  Encrypted: true,
  KmsKeyId: 'arn:aws:kms:eu-west-1:111122223333:key/11111111-2222-3333-4444-555555555555',
  MultiAttachEnabled: false,
  Attachments: []
}

/** An io2 volume attached to two instances at once (Multi-Attach). */
export const multiAttached: Volume = {
  VolumeId: 'vol-0eee5555ffff66667',
  VolumeType: 'io2',
  Size: 100,
  Iops: 5000,
  State: 'in-use',
  AvailabilityZone: 'us-east-1c',
  CreateTime: new Date('2026-11-01T09:00:00.000Z'),
  MultiAttachEnabled: true,
  Attachments: [
    { VolumeId: 'vol-0eee5555ffff66667', InstanceId: 'i-0eee5555ffff66667', State: 'attached' },
    { VolumeId: 'vol-0eee5555ffff66667', InstanceId: 'i-0fff6666aaaa77778', State: 'attached' }
  ],
  Tags: [{ Key: 'Name', Value: '' }]
}

/** A magnetic (standard) volume with no IOPS figure. */
export const magnetic: Volume = {
  VolumeId: 'vol-0111222233334444a',
  VolumeType: 'standard',
  Size: 30,
  State: 'available',
  AvailabilityZone: 'eu-west-1a',
  CreateTime: new Date('2025-03-01T00:00:00.000Z'),
  Attachments: []
}

/** A deleted volume can still be listed for a short while. It costs nothing. */
export const deleted: Volume = {
  VolumeId: 'vol-0999888877776666a',
  VolumeType: 'gp2',
  Size: 8,
  Iops: 100,
  State: 'deleted',
  AvailabilityZone: 'eu-west-1a',
  CreateTime: new Date('2026-11-09T10:00:00.000Z'),
  Attachments: []
}
