// Every scanner the app runs. The engine runs each one in each enabled region.
// M4 adds EBS volumes, Elastic IPs, NAT gateways, load balancers and SageMaker.

import type { Scanner } from '../scan/scanner'
import { ebsVolumes } from './ebsVolumes'
import { ec2Instances } from './ec2Instances'
import { elasticIps } from './elasticIps'
import { loadBalancers } from './loadBalancers'
import { natGateways } from './natGateways'
import { rdsInstances } from './rdsInstances'

export const ALL_SCANNERS: readonly Scanner[] = [
  ec2Instances,
  ebsVolumes,
  elasticIps,
  natGateways,
  rdsInstances,
  loadBalancers
]
