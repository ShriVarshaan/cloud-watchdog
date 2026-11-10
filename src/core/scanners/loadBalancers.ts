// Load balancers in one region: Application, Network and Gateway load
// balancers (the ELBv2 API) and classic load balancers (the original ELB API).
// One scanner covers both because they are one kind of resource to the user,
// and one IAM action, `elasticloadbalancing:DescribeLoadBalancers`, allows both.
// Otherwise the same three steps as ec2Instances.ts.
//
// Ids: ELBv2 uses the end of the ARN, `app/<name>/<hash>`, which is unique and
// carries the type. Classic uses its name, which cannot contain "/", so the two
// can never collide.
//
// The hourly rate is all a describe call can price. Capacity units (LCU, NLCU,
// GLCU) depend on traffic and are not seen here.

import {
  ElasticLoadBalancingClient,
  paginateDescribeLoadBalancers as paginateClassic,
  type LoadBalancerDescription
} from '@aws-sdk/client-elastic-load-balancing'
import {
  ElasticLoadBalancingV2Client,
  paginateDescribeLoadBalancers as paginateV2,
  type LoadBalancer
} from '@aws-sdk/client-elastic-load-balancing-v2'
import { resourceKey, type Resource } from '../../shared/types'
import type { ScanContext, Scanner } from '../scan/scanner'

const ARN_RESOURCE = ':loadbalancer/'

function fromV2(lb: LoadBalancer, ctx: ScanContext): Resource | null {
  const arn = lb.LoadBalancerArn
  if (!arn) return null
  const at = arn.indexOf(ARN_RESOURCE)
  const id = at === -1 ? arn : arn.slice(at + ARN_RESOURCE.length)

  return {
    key: resourceKey(ctx.accountId, 'load-balancer', ctx.region, id),
    kind: 'load-balancer',
    region: ctx.region,
    id,
    ...(lb.LoadBalancerName ? { name: lb.LoadBalancerName } : {}),
    // active | provisioning | active_impaired | failed
    state: lb.State?.Code ?? 'unknown',
    ...(lb.CreatedTime ? { createdAt: lb.CreatedTime.toISOString() } : {}),
    attrs: {
      type: lb.Type ?? null,
      // Gateway load balancers have no scheme.
      scheme: lb.Scheme ?? null,
      ipAddressType: lb.IpAddressType ?? null,
      // An internet-facing one holds a public IPv4 address in each zone.
      zoneCount: lb.AvailabilityZones?.length ?? 0
    }
  }
}

function fromClassic(lb: LoadBalancerDescription, ctx: ScanContext): Resource | null {
  const id = lb.LoadBalancerName
  if (!id) return null

  return {
    key: resourceKey(ctx.accountId, 'load-balancer', ctx.region, id),
    kind: 'load-balancer',
    region: ctx.region,
    id,
    name: id,
    // The classic API reports no state. One that is listed exists, and bills.
    state: 'active',
    ...(lb.CreatedTime ? { createdAt: lb.CreatedTime.toISOString() } : {}),
    attrs: {
      type: 'classic',
      scheme: lb.Scheme ?? null,
      // Classic load balancers are IPv4 only.
      ipAddressType: 'ipv4',
      zoneCount: lb.AvailabilityZones?.length ?? 0
    }
  }
}

export const loadBalancers: Scanner = {
  kind: 'load-balancer',
  service: 'elb',
  requiredActions: ['elasticloadbalancing:DescribeLoadBalancers'],

  async scan(ctx) {
    const resources: Resource[] = []
    const options = { abortSignal: ctx.signal }

    const v2 = ctx.clients.get(ElasticLoadBalancingV2Client, ctx.region)
    for await (const page of paginateV2({ client: v2 }, {}, options)) {
      for (const lb of page.LoadBalancers ?? []) {
        const resource = fromV2(lb, ctx)
        if (resource) resources.push(resource)
      }
    }

    const classic = ctx.clients.get(ElasticLoadBalancingClient, ctx.region)
    for await (const page of paginateClassic({ client: classic }, {}, options)) {
      for (const lb of page.LoadBalancerDescriptions ?? []) {
        const resource = fromClassic(lb, ctx)
        if (resource) resources.push(resource)
      }
    }

    return resources
  }
}
