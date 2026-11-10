// Elastic IP addresses in one region.
//
// DescribeAddresses is not paginated: one call returns every address, so this
// scanner sends the command directly instead of using a paginator. Otherwise
// it follows ec2Instances.ts.
//
// Every public IPv4 address bills hourly, attached or not. An unattached one
// is still worth flagging because it does nothing for its cost.

import { DescribeAddressesCommand, EC2Client, type Address } from '@aws-sdk/client-ec2'
import { resourceKey, type Resource } from '../../shared/types'
import type { ScanContext, Scanner } from '../scan/scanner'
import { nameFromTags } from './tags'

function toResource(address: Address, ctx: ScanContext): Resource | null {
  // AllocationId is always set for VPC addresses, which is all of them today.
  const id = address.AllocationId ?? address.PublicIp
  if (!id) return null

  // An address can be on a network interface with no instance (NAT gateway, load balancer, ...).
  const associated = !!(address.AssociationId || address.InstanceId || address.NetworkInterfaceId)
  return {
    key: resourceKey(ctx.accountId, 'elastic-ip', ctx.region, id),
    kind: 'elastic-ip',
    region: ctx.region,
    id,
    ...nameFromTags(address.Tags),
    state: associated ? 'associated' : 'unassociated',
    attrs: {
      publicIp: address.PublicIp ?? null,
      associatedInstanceId: address.InstanceId ?? null,
      networkInterfaceId: address.NetworkInterfaceId ?? null,
      // 'amazon' for Amazon's pool. Anything else is an address pool the account brought itself (BYOIP).
      publicIpv4Pool: address.PublicIpv4Pool ?? null
    }
  }
}

export const elasticIps: Scanner = {
  kind: 'elastic-ip',
  service: 'ec2',
  requiredActions: ['ec2:DescribeAddresses'],

  async scan(ctx) {
    const client = ctx.clients.get(EC2Client, ctx.region)
    const response = await client.send(new DescribeAddressesCommand({}), { abortSignal: ctx.signal })
    const resources: Resource[] = []
    for (const address of response.Addresses ?? []) {
      const resource = toResource(address, ctx)
      if (resource) resources.push(resource)
    }
    return resources
  }
}
