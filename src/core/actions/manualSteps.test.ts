import { describe, expect, it } from 'vitest'
import type { AttrValue, Resource, ResourceKind } from '../../shared/types'
import { buildManualSteps } from './manualSteps'

const ACCOUNT = '111122223333'

function make(kind: ResourceKind, id: string, state: string, attrs: Record<string, AttrValue> = {}, region = 'eu-west-1'): Resource {
  return { key: `${ACCOUNT}:${kind}:${region}:${id}`, kind, region, id, state, attrs }
}

describe('buildManualSteps', () => {
  it.each<[string, Resource, string, string | null]>([
    [
      'a running instance: stop it',
      make('ec2-instance', 'i-0abc', 'running'),
      'https://eu-west-1.console.aws.amazon.com/ec2/home?region=eu-west-1#InstanceDetails:instanceId=i-0abc',
      'aws ec2 stop-instances --instance-ids i-0abc --region eu-west-1 --profile hackathon'
    ],
    [
      'a stopped instance: no command, the console shows its disks',
      make('ec2-instance', 'i-0abc', 'stopped'),
      'https://eu-west-1.console.aws.amazon.com/ec2/home?region=eu-west-1#InstanceDetails:instanceId=i-0abc',
      null
    ],
    [
      'an unattached volume: delete it',
      make('ebs-volume', 'vol-0abc', 'available'),
      'https://eu-west-1.console.aws.amazon.com/ec2/home?region=eu-west-1#VolumeDetails:volumeId=vol-0abc',
      'aws ec2 delete-volume --volume-id vol-0abc --region eu-west-1 --profile hackathon'
    ],
    [
      'a volume in use: no command',
      make('ebs-volume', 'vol-0abc', 'in-use'),
      'https://eu-west-1.console.aws.amazon.com/ec2/home?region=eu-west-1#VolumeDetails:volumeId=vol-0abc',
      null
    ],
    [
      'an unused Elastic IP: release it',
      make('elastic-ip', 'eipalloc-0abc', 'unassociated'),
      'https://eu-west-1.console.aws.amazon.com/ec2/home?region=eu-west-1#ElasticIpDetails:AllocationId=eipalloc-0abc',
      'aws ec2 release-address --allocation-id eipalloc-0abc --region eu-west-1 --profile hackathon'
    ],
    [
      'a NAT gateway: delete it',
      make('nat-gateway', 'nat-0abc', 'available'),
      'https://eu-west-1.console.aws.amazon.com/vpcconsole/home?region=eu-west-1#NatGatewayDetails:natGatewayId=nat-0abc',
      'aws ec2 delete-nat-gateway --nat-gateway-id nat-0abc --region eu-west-1 --profile hackathon'
    ],
    [
      'an available database: stop it',
      make('rds-instance', 'shop-db', 'available'),
      'https://eu-west-1.console.aws.amazon.com/rds/home?region=eu-west-1#database:id=shop-db;is-cluster=false',
      'aws rds stop-db-instance --db-instance-identifier shop-db --region eu-west-1 --profile hackathon'
    ],
    [
      'an application load balancer: delete it by ARN',
      make('load-balancer', 'app/web-alb/50dc6c495c0c9188', 'active', { type: 'application' }),
      'https://eu-west-1.console.aws.amazon.com/ec2/home?region=eu-west-1#LoadBalancers:search=web-alb',
      'aws elbv2 delete-load-balancer --load-balancer-arn arn:aws:elasticloadbalancing:eu-west-1:111122223333:loadbalancer/app/web-alb/50dc6c495c0c9188 --region eu-west-1 --profile hackathon'
    ],
    [
      'a classic load balancer: delete it by name',
      make('load-balancer', 'old-elb', 'active', { type: 'classic' }),
      'https://eu-west-1.console.aws.amazon.com/ec2/home?region=eu-west-1#LoadBalancers:search=old-elb',
      'aws elb delete-load-balancer --load-balancer-name old-elb --region eu-west-1 --profile hackathon'
    ],
    [
      'a SageMaker endpoint: delete it',
      make('sagemaker-endpoint', 'my-model', 'in-service'),
      'https://eu-west-1.console.aws.amazon.com/sagemaker/home?region=eu-west-1#/endpoints/my-model',
      'aws sagemaker delete-endpoint --endpoint-name my-model --region eu-west-1 --profile hackathon'
    ]
  ])('%s', (_name, resource, consoleUrl, cliCommand) => {
    const steps = buildManualSteps(resource, 'hackathon')
    expect(steps.consoleUrl).toBe(consoleUrl)
    expect(steps.cliCommand).toBe(cliCommand)
    expect(steps.cliNote === null).toBe(cliCommand === null)
  })

  it('warns that deleting a volume loses its data', () => {
    expect(buildManualSteps(make('ebs-volume', 'vol-0abc', 'available'), 'p').cliNote).toMatch(/snapshot/i)
  })

  it('warns that a stopped database starts again after 7 days', () => {
    expect(buildManualSteps(make('rds-instance', 'db', 'available'), 'p').cliNote).toMatch(/7 days/)
  })

  it('quotes a profile name with spaces or other unusual characters', () => {
    const steps = buildManualSteps(make('nat-gateway', 'nat-0abc', 'available'), 'my "team" profile')
    expect(steps.cliCommand).toBe(`aws ec2 delete-nat-gateway --nat-gateway-id nat-0abc --region eu-west-1 --profile 'my "team" profile'`)
  })

  it('quotes an id that is not a plain word', () => {
    const steps = buildManualSteps(make('sagemaker-endpoint', 'odd name', 'in-service'), 'p')
    expect(steps.cliCommand).toBe(`aws sagemaker delete-endpoint --endpoint-name 'odd name' --region eu-west-1 --profile p`)
    expect(steps.consoleUrl).toBe('https://eu-west-1.console.aws.amazon.com/sagemaker/home?region=eu-west-1#/endpoints/odd%20name')
  })

  it('leaves out the profile flag when there is no profile name', () => {
    expect(buildManualSteps(make('nat-gateway', 'nat-0abc', 'available'), null).cliCommand).toBe(
      'aws ec2 delete-nat-gateway --nat-gateway-id nat-0abc --region eu-west-1'
    )
  })
})
