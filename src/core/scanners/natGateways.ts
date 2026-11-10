// NAT gateways in one region. Same three steps as ec2Instances.ts.
//
// A NAT gateway bills every hour it exists, plus a charge per GB processed
// that no describe call can see. The Elastic IP on a public gateway is found
// and priced by elasticIps.ts, not here.

import { EC2Client, paginateDescribeNatGateways, type NatGateway } from '@aws-sdk/client-ec2'
import { resourceKey, type Resource } from '../../shared/types'
import type { ScanContext, Scanner } from '../scan/scanner'
import { nameFromTags } from './tags'

/** Final states. Deleted gateways stay listed for about an hour; failed ones are never billed. */
const GONE = new Set(['deleted', 'failed'])

function toResource(gateway: NatGateway, ctx: ScanContext): Resource | null {
  const id = gateway.NatGatewayId
  const state = gateway.State
  if (!id || (state && GONE.has(state))) return null

  return {
    key: resourceKey(ctx.accountId, 'nat-gateway', ctx.region, id),
    kind: 'nat-gateway',
    region: ctx.region,
    id,
    ...nameFromTags(gateway.Tags),
    state: state ?? 'unknown',
    ...(gateway.CreateTime ? { createdAt: gateway.CreateTime.toISOString() } : {}),
    attrs: {
      connectivityType: gateway.ConnectivityType ?? null,
      // 'regional' gateways span several zones. AWS omits the field for the original zonal kind.
      availabilityMode: gateway.AvailabilityMode ?? 'zonal'
    }
  }
}

export const natGateways: Scanner = {
  kind: 'nat-gateway',
  service: 'ec2',
  requiredActions: ['ec2:DescribeNatGateways'],

  async scan(ctx) {
    const client = ctx.clients.get(EC2Client, ctx.region)
    const resources: Resource[] = []
    for await (const page of paginateDescribeNatGateways({ client }, {}, { abortSignal: ctx.signal })) {
      for (const gateway of page.NatGateways ?? []) {
        const resource = toResource(gateway, ctx)
        if (resource) resources.push(resource)
      }
    }
    return resources
  }
}
