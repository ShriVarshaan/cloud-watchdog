// Hand-written DescribeLoadBalancers data (ELBv2 and classic ELB) in the shape
// the SDK returns it, with made-up ids. Replace or extend with recorded
// responses from `scripts/record-fixtures.ts` (see tests/fixtures/recorded/).

import type { LoadBalancerDescription } from '@aws-sdk/client-elastic-load-balancing'
import type { LoadBalancer } from '@aws-sdk/client-elastic-load-balancing-v2'

/** An internet-facing Application Load Balancer in two zones. */
export const albActive: LoadBalancer = {
  LoadBalancerArn: 'arn:aws:elasticloadbalancing:eu-west-1:111122223333:loadbalancer/app/demo-alb/50dc6c495c0c9188',
  LoadBalancerName: 'demo-alb',
  DNSName: 'demo-alb-1234567890.eu-west-1.elb.amazonaws.com',
  CanonicalHostedZoneId: 'Z32O12XQLNTSW2',
  CreatedTime: new Date('2026-11-06T10:00:00.000Z'),
  Scheme: 'internet-facing',
  VpcId: 'vpc-0aaa1111bbbb22223',
  State: { Code: 'active' },
  Type: 'application',
  AvailabilityZones: [
    { ZoneName: 'eu-west-1a', SubnetId: 'subnet-0aaa1111bbbb22223' },
    { ZoneName: 'eu-west-1b', SubnetId: 'subnet-0ccc3333dddd44445' }
  ],
  SecurityGroups: ['sg-0aaa1111bbbb22223'],
  IpAddressType: 'ipv4'
}

/** An internal Network Load Balancer still provisioning, in three zones. */
export const nlbProvisioning: LoadBalancer = {
  LoadBalancerArn: 'arn:aws:elasticloadbalancing:eu-west-1:111122223333:loadbalancer/net/api-nlb/73e2d6bc24d8a067',
  LoadBalancerName: 'api-nlb',
  CreatedTime: new Date('2026-11-10T13:50:00.000Z'),
  Scheme: 'internal',
  State: { Code: 'provisioning' },
  Type: 'network',
  AvailabilityZones: [{ ZoneName: 'eu-west-1a' }, { ZoneName: 'eu-west-1b' }, { ZoneName: 'eu-west-1c' }],
  IpAddressType: 'dualstack'
}

/** A Gateway Load Balancer. */
export const gwlbActive: LoadBalancer = {
  LoadBalancerArn: 'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/gwy/inspect-gwlb/1a2b3c4d5e6f7a8b',
  LoadBalancerName: 'inspect-gwlb',
  CreatedTime: new Date('2026-10-30T08:00:00.000Z'),
  State: { Code: 'active' },
  Type: 'gateway',
  AvailabilityZones: [{ ZoneName: 'us-east-1a' }],
  IpAddressType: 'ipv4'
}

/** A classic load balancer: no type, no state, zones as plain names. */
export const classic: LoadBalancerDescription = {
  LoadBalancerName: 'legacy-web',
  DNSName: 'legacy-web-987654321.eu-west-1.elb.amazonaws.com',
  CanonicalHostedZoneNameID: 'Z32O12XQLNTSW2',
  ListenerDescriptions: [
    { Listener: { Protocol: 'HTTP', LoadBalancerPort: 80, InstanceProtocol: 'HTTP', InstancePort: 80 }, PolicyNames: [] }
  ],
  AvailabilityZones: ['eu-west-1a', 'eu-west-1b'],
  Subnets: ['subnet-0aaa1111bbbb22223', 'subnet-0ccc3333dddd44445'],
  VPCId: 'vpc-0aaa1111bbbb22223',
  Instances: [{ InstanceId: 'i-0aaa1111bbbb22223' }],
  CreatedTime: new Date('2025-06-01T12:00:00.000Z'),
  Scheme: 'internet-facing'
}
