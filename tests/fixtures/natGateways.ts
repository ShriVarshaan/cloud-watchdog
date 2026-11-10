// Hand-written DescribeNatGateways data in the shape the SDK returns it, with
// made-up ids. Replace or extend with recorded responses from
// `scripts/record-fixtures.ts` (see tests/fixtures/recorded/).

import type { NatGateway } from '@aws-sdk/client-ec2'

/** A public, zonal NAT gateway with an Elastic IP and a Name tag. */
export const publicAvailable: NatGateway = {
  NatGatewayId: 'nat-0aaa1111bbbb22223',
  State: 'available',
  ConnectivityType: 'public',
  AvailabilityMode: 'zonal',
  CreateTime: new Date('2026-11-07T16:00:00.000Z'),
  SubnetId: 'subnet-0aaa1111bbbb22223',
  VpcId: 'vpc-0aaa1111bbbb22223',
  NatGatewayAddresses: [
    {
      AllocationId: 'eipalloc-0eee5555ffff66667',
      NetworkInterfaceId: 'eni-0eee5555ffff66667',
      PrivateIp: '10.0.0.10',
      PublicIp: '203.0.113.22',
      AssociationId: 'eipassoc-0eee5555ffff66667',
      IsPrimary: true,
      Status: 'succeeded'
    }
  ],
  Tags: [{ Key: 'Name', Value: 'demo-nat' }]
}

/** A private NAT gateway still being created. Older SDK responses leave AvailabilityMode out. */
export const privatePending: NatGateway = {
  NatGatewayId: 'nat-0ccc3333dddd44445',
  State: 'pending',
  ConnectivityType: 'private',
  CreateTime: new Date('2026-11-10T13:55:00.000Z'),
  SubnetId: 'subnet-0ccc3333dddd44445',
  VpcId: 'vpc-0aaa1111bbbb22223',
  NatGatewayAddresses: [{ NetworkInterfaceId: 'eni-0ccc3333dddd44445', PrivateIp: '10.0.3.7', IsPrimary: true }]
}

/** A regional NAT gateway, which spans the VPC's availability zones. */
export const regionalAvailable: NatGateway = {
  NatGatewayId: 'nat-0eee5555ffff66667',
  State: 'available',
  ConnectivityType: 'public',
  AvailabilityMode: 'regional',
  CreateTime: new Date('2026-11-02T11:20:00.000Z'),
  VpcId: 'vpc-0eee5555ffff66667',
  Tags: [{ Key: 'Name', Value: '' }]
}

/** Being deleted: still listed, and still billed until it is gone. */
export const deleting: NatGateway = {
  NatGatewayId: 'nat-0111222233334444a',
  State: 'deleting',
  ConnectivityType: 'public',
  CreateTime: new Date('2026-11-01T08:00:00.000Z'),
  VpcId: 'vpc-0aaa1111bbbb22223'
}

/** Deleted gateways stay listed for about an hour. They cost nothing. */
export const deleted: NatGateway = {
  NatGatewayId: 'nat-0999888877776666a',
  State: 'deleted',
  ConnectivityType: 'public',
  CreateTime: new Date('2026-11-09T10:00:00.000Z'),
  DeleteTime: new Date('2026-11-09T12:00:00.000Z'),
  VpcId: 'vpc-0aaa1111bbbb22223'
}

/** Creation failed. AWS does not bill it and removes it after a while. */
export const failed: NatGateway = {
  NatGatewayId: 'nat-0888777766665555b',
  State: 'failed',
  ConnectivityType: 'public',
  CreateTime: new Date('2026-11-10T09:00:00.000Z'),
  FailureCode: 'Gateway.NotAttached',
  FailureMessage: 'Network vpc-0aaa1111bbbb22223 has no Internet gateway attached',
  VpcId: 'vpc-0aaa1111bbbb22223'
}
