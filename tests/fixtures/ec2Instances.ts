// Hand-written DescribeInstances data in the shape the SDK returns it, with
// made-up ids. Replace or extend with recorded responses from
// `scripts/record-fixtures.ts` (see tests/fixtures/recorded/).

import type { Instance, Reservation } from '@aws-sdk/client-ec2'

/** A plain on-demand Linux instance with a public IP and a Name tag. */
export const runningLinux: Instance = {
  InstanceId: 'i-0aaa1111bbbb22223',
  ImageId: 'ami-0123456789abcdef0',
  InstanceType: 't3.micro',
  State: { Code: 16, Name: 'running' },
  LaunchTime: new Date('2026-11-08T14:30:00.000Z'),
  Architecture: 'x86_64',
  PlatformDetails: 'Linux/UNIX',
  UsageOperation: 'RunInstances',
  UsageOperationUpdateTime: new Date('2026-11-08T14:30:00.000Z'),
  Placement: { AvailabilityZone: 'eu-west-1a', GroupName: '', Tenancy: 'default' },
  Monitoring: { State: 'disabled' },
  PrivateIpAddress: '10.0.1.25',
  PrivateDnsName: 'ip-10-0-1-25.eu-west-1.compute.internal',
  PublicIpAddress: '203.0.113.10',
  PublicDnsName: 'ec2-203-0-113-10.eu-west-1.compute.amazonaws.com',
  SubnetId: 'subnet-0aaa1111bbbb22223',
  VpcId: 'vpc-0aaa1111bbbb22223',
  RootDeviceName: '/dev/xvda',
  RootDeviceType: 'ebs',
  BlockDeviceMappings: [
    {
      DeviceName: '/dev/xvda',
      Ebs: {
        VolumeId: 'vol-0aaa1111bbbb22223',
        Status: 'attached',
        AttachTime: new Date('2026-11-08T14:30:01.000Z'),
        DeleteOnTermination: true
      }
    }
  ],
  EbsOptimized: true,
  EnaSupport: true,
  Hypervisor: 'xen',
  VirtualizationType: 'hvm',
  SecurityGroups: [{ GroupId: 'sg-0aaa1111bbbb22223', GroupName: 'default' }],
  SourceDestCheck: true,
  CpuOptions: { CoreCount: 1, ThreadsPerCore: 2 },
  Tags: [
    { Key: 'Name', Value: 'demo-web' },
    { Key: 'project', Value: 'hackathon' }
  ]
}

/** A stopped Windows instance: no public IP, no tags. */
export const stoppedWindows: Instance = {
  InstanceId: 'i-0ccc3333dddd44445',
  ImageId: 'ami-0fedcba9876543210',
  InstanceType: 'm5.large',
  State: { Code: 80, Name: 'stopped' },
  LaunchTime: new Date('2026-10-01T08:00:00.000Z'),
  Architecture: 'x86_64',
  Platform: 'Windows',
  PlatformDetails: 'Windows',
  UsageOperation: 'RunInstances:0002',
  Placement: { AvailabilityZone: 'eu-west-1b', GroupName: '', Tenancy: 'dedicated' },
  PrivateIpAddress: '10.0.2.40',
  RootDeviceName: '/dev/sda1',
  RootDeviceType: 'ebs',
  StateTransitionReason: 'User initiated (2026-10-02 09:00:00 GMT)',
  StateReason: { Code: 'Client.UserInitiatedShutdown', Message: 'Client.UserInitiatedShutdown: User initiated shutdown' }
}

/** A GPU spot instance launched by an Auto Scaling group, with an instance-store root. */
export const spotGpuInAsg: Instance = {
  InstanceId: 'i-0eee5555ffff66667',
  ImageId: 'ami-0123456789abcdef0',
  InstanceType: 'g5.xlarge',
  State: { Code: 16, Name: 'running' },
  LaunchTime: new Date('2026-11-10T01:15:00.000Z'),
  PlatformDetails: 'Linux/UNIX',
  UsageOperation: 'RunInstances',
  InstanceLifecycle: 'spot',
  SpotInstanceRequestId: 'sir-abcd1234',
  Placement: { AvailabilityZone: 'us-east-1c', Tenancy: 'default' },
  PrivateIpAddress: '10.1.0.7',
  RootDeviceType: 'instance-store',
  Tags: [
    { Key: 'aws:autoscaling:groupName', Value: 'training-fleet' },
    { Key: 'Name', Value: '' }
  ]
}

/** Terminated instances stay listed for about an hour and cost nothing. */
export const terminated: Instance = {
  InstanceId: 'i-0999888877776666a',
  InstanceType: 't3.micro',
  State: { Code: 48, Name: 'terminated' },
  LaunchTime: new Date('2026-11-09T10:00:00.000Z'),
  PlatformDetails: 'Linux/UNIX',
  UsageOperation: 'RunInstances',
  Placement: { AvailabilityZone: 'eu-west-1a', Tenancy: 'default' },
  RootDeviceType: 'ebs',
  StateTransitionReason: 'User initiated (2026-11-09 11:00:00 GMT)'
}

export function reservation(...Instances: Instance[]): Reservation {
  return { ReservationId: 'r-0aaa1111bbbb22223', OwnerId: '111122223333', Groups: [], Instances }
}
