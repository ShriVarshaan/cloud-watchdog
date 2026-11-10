// Hand-written DescribeAddresses data in the shape the SDK returns it, with
// made-up ids. Replace or extend with recorded responses from
// `scripts/record-fixtures.ts` (see tests/fixtures/recorded/).

import type { Address } from '@aws-sdk/client-ec2'

/** An Elastic IP attached to a running instance, with a Name tag. */
export const associatedToInstance: Address = {
  AllocationId: 'eipalloc-0aaa1111bbbb22223',
  AssociationId: 'eipassoc-0aaa1111bbbb22223',
  PublicIp: '203.0.113.20',
  Domain: 'vpc',
  InstanceId: 'i-0aaa1111bbbb22223',
  NetworkInterfaceId: 'eni-0aaa1111bbbb22223',
  NetworkInterfaceOwnerId: '111122223333',
  PrivateIpAddress: '10.0.1.25',
  PublicIpv4Pool: 'amazon',
  NetworkBorderGroup: 'eu-west-1',
  Tags: [{ Key: 'Name', Value: 'demo-web-ip' }]
}

/** An Elastic IP that is allocated but attached to nothing. */
export const unassociated: Address = {
  AllocationId: 'eipalloc-0ccc3333dddd44445',
  PublicIp: '203.0.113.21',
  Domain: 'vpc',
  PublicIpv4Pool: 'amazon',
  NetworkBorderGroup: 'eu-west-1'
}

/** Attached to a network interface that belongs to a NAT gateway, not an instance. */
export const onNatGatewayEni: Address = {
  AllocationId: 'eipalloc-0eee5555ffff66667',
  AssociationId: 'eipassoc-0eee5555ffff66667',
  PublicIp: '203.0.113.22',
  Domain: 'vpc',
  NetworkInterfaceId: 'eni-0eee5555ffff66667',
  NetworkInterfaceOwnerId: '111122223333',
  PrivateIpAddress: '10.0.0.10',
  PublicIpv4Pool: 'amazon',
  NetworkBorderGroup: 'us-east-1',
  Tags: [{ Key: 'Name', Value: '' }]
}

/** From an address pool the account brought itself (BYOIP). */
export const byoip: Address = {
  AllocationId: 'eipalloc-0111222233334444a',
  PublicIp: '198.51.100.5',
  Domain: 'vpc',
  PublicIpv4Pool: 'ipv4pool-ec2-0111222233334444a',
  NetworkBorderGroup: 'eu-west-1'
}
