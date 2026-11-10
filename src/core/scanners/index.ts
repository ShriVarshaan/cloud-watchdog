// Every scanner the app runs, one per resource kind. The engine runs each one
// in each enabled region.

import type { Scanner } from '../scan/scanner'
import { ebsVolumes } from './ebsVolumes'
import { ec2Instances } from './ec2Instances'
import { elasticIps } from './elasticIps'
import { loadBalancers } from './loadBalancers'
import { natGateways } from './natGateways'
import { rdsInstances } from './rdsInstances'
import { sagemakerEndpoints } from './sagemakerEndpoints'

export const ALL_SCANNERS: readonly Scanner[] = [
  ec2Instances,
  ebsVolumes,
  elasticIps,
  natGateways,
  rdsInstances,
  loadBalancers,
  sagemakerEndpoints
]
