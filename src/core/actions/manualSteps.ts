// What the user can do by hand about a resource: a link to it in the AWS
// console, and the AWS CLI command that stops the cost, to copy.
//
// The app never runs these commands. Several of them delete things, which the
// app will never do itself; the note says what is lost. When the cost cannot
// be stopped with one safe command (a stopped instance still paying for its
// disks, a disk in use), there is no command, only the console link.
//
// Built in the main process from the app's own data. The UI never supplies a
// URL or a command.

import type { ManualSteps, Resource } from '../../shared/types'

/** Wraps a value for a shell (PowerShell or bash) unless it is a plain word. */
function quote(value: string): string {
  return /^[A-Za-z0-9._:/@=+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`
}

function consoleUrl(region: string, service: string, fragment: string): string {
  const r = encodeURIComponent(region)
  return `https://${r}.console.aws.amazon.com/${service}/home?region=${r}#${fragment}`
}

interface Command {
  args: string[]
  note: string
}

function command(resource: Resource): Command | null {
  const { id, region, state } = resource
  const accountId = resource.key.split(':')[0]

  switch (resource.kind) {
    case 'ec2-instance':
      return state === 'running'
        ? {
            args: ['ec2', 'stop-instances', '--instance-ids', id],
            note: 'Stops the instance. Its disks keep billing, and it gets a new public IP address when started again, unless it has an Elastic IP.'
          }
        : null
    case 'ebs-volume':
      return state === 'available'
        ? {
            args: ['ec2', 'delete-volume', '--volume-id', id],
            note: 'Deletes the volume and everything on it, permanently. Take a snapshot first if you may need the data.'
          }
        : null
    case 'elastic-ip':
      return state === 'unassociated'
        ? {
            args: ['ec2', 'release-address', '--allocation-id', id],
            note: 'Gives the address back to AWS. You cannot get the same address again.'
          }
        : null
    case 'nat-gateway':
      return {
        args: ['ec2', 'delete-nat-gateway', '--nat-gateway-id', id],
        note: 'Deletes the NAT gateway. Servers in private subnets lose internet access. Its Elastic IP is kept and keeps billing until released.'
      }
    case 'rds-instance':
      return state === 'available'
        ? {
            args: ['rds', 'stop-db-instance', '--db-instance-identifier', id],
            note: 'Stops the database. AWS starts it again by itself after 7 days. Storage and backups keep billing while it is stopped.'
          }
        : null
    case 'load-balancer':
      return resource.attrs.type === 'classic'
        ? {
            args: ['elb', 'delete-load-balancer', '--load-balancer-name', id],
            note: 'Deletes the load balancer. Anything sending traffic to it stops working.'
          }
        : {
            args: [
              'elbv2',
              'delete-load-balancer',
              '--load-balancer-arn',
              `arn:aws:elasticloadbalancing:${region}:${accountId}:loadbalancer/${id}`
            ],
            note: 'Deletes the load balancer. Anything sending traffic to it stops working.'
          }
    case 'sagemaker-endpoint':
      return {
        args: ['sagemaker', 'delete-endpoint', '--endpoint-name', id],
        note: 'Deletes the endpoint. The model and endpoint configuration are kept, so it can be deployed again.'
      }
  }
}

function link(resource: Resource): string {
  const { id, region } = resource
  const e = encodeURIComponent(id)
  switch (resource.kind) {
    case 'ec2-instance':
      return consoleUrl(region, 'ec2', `InstanceDetails:instanceId=${e}`)
    case 'ebs-volume':
      return consoleUrl(region, 'ec2', `VolumeDetails:volumeId=${e}`)
    case 'elastic-ip':
      return consoleUrl(region, 'ec2', `ElasticIpDetails:AllocationId=${e}`)
    case 'nat-gateway':
      return consoleUrl(region, 'vpcconsole', `NatGatewayDetails:natGatewayId=${e}`)
    case 'rds-instance':
      return consoleUrl(region, 'rds', `database:id=${e};is-cluster=false`)
    case 'load-balancer': {
      // ELBv2 ids are "app/<name>/<hash>"; the console searches by name.
      const name = id.includes('/') ? (id.split('/')[1] ?? id) : id
      return consoleUrl(region, 'ec2', `LoadBalancers:search=${encodeURIComponent(name)}`)
    }
    case 'sagemaker-endpoint':
      return consoleUrl(region, 'sagemaker', `/endpoints/${e}`)
  }
}

export function buildManualSteps(resource: Resource, profile: string | null): ManualSteps {
  const found = command(resource)
  const args = found ? [...found.args, '--region', resource.region, ...(profile ? ['--profile', profile] : [])] : null
  return {
    consoleUrl: link(resource),
    cliCommand: args ? ['aws', ...args.map(quote)].join(' ') : null,
    cliNote: found?.note ?? null
  }
}
