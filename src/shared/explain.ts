// Plain-English text about each kind of resource and each rule, for the UI.
// In src/shared (not src/core) because the renderer may import only from
// here; it is static text with no logic.

import type { ResourceKind } from './types'

export interface KindExplanation {
  /** Singular, sentence case: "EC2 instance". */
  name: string
  /** What it is, for someone who may have created it by following a tutorial. */
  what: string
  /** What it costs while it exists, and what stops the cost. */
  cost: string
}

export const KIND_EXPLANATIONS: Record<ResourceKind, KindExplanation> = {
  'ec2-instance': {
    name: 'EC2 instance',
    what: 'A virtual server. It is what most tutorials mean by "launch an instance".',
    cost: 'Billed by the second while it is running. Stopping it ends the compute charge, but its disks (EBS volumes) keep billing until they are deleted.'
  },
  'ebs-volume': {
    name: 'EBS volume',
    what: 'A disk for an EC2 instance. Instances create one automatically, and it often survives when the instance is terminated.',
    cost: 'Billed for its full size every hour it exists, attached or not, whether or not anything is written to it. Only deleting it stops the charge.'
  },
  'elastic-ip': {
    name: 'Elastic IP',
    what: 'A fixed public IPv4 address that stays with the account until it is released.',
    cost: 'Every public IPv4 address bills by the hour, in use or not. Releasing it stops the charge; the address cannot be got back afterwards.'
  },
  'nat-gateway': {
    name: 'NAT gateway',
    what: 'Lets servers in a private subnet reach the internet. VPC wizards and many templates create one without asking.',
    cost: 'Billed every hour it exists, plus a charge for every GB it passes. One of the most common surprise bills; deleting it stops both.'
  },
  'rds-instance': {
    name: 'RDS database',
    what: 'A managed database server (MySQL, PostgreSQL and others).',
    cost: 'Billed by the hour while available, plus its storage. Stopping it ends the hourly charge for up to 7 days, after which AWS starts it again by itself. Storage and backups keep billing while stopped.'
  },
  'load-balancer': {
    name: 'Load balancer',
    what: 'Spreads traffic over several servers. Often created by Elastic Beanstalk, ECS or Kubernetes tutorials.',
    cost: 'Billed every hour it exists, plus capacity units that depend on traffic. Deleting it stops the charge.'
  },
  'sagemaker-endpoint': {
    name: 'SageMaker endpoint',
    what: 'A machine learning model deployed on servers so it can answer requests.',
    cost: 'Billed every hour for each instance behind it, even when no requests arrive. Deleting the endpoint stops the charge; the model itself is kept.'
  }
}

export interface RuleParamInfo {
  label: string
  /** Shown after the number: "hours", "%". */
  unit: string
  default: number
}

export interface RuleInfo {
  label: string
  description: string
  params: Record<string, RuleParamInfo>
}

/** Every rule the app has. Kept in step with src/core/rules/rules.ts by a test. */
export const RULE_INFO: Record<string, RuleInfo> = {
  'long-running': {
    label: 'Running a long time',
    description: 'A server, database or endpoint has been running longer than this.',
    params: { hours: { label: 'Warn after', unit: 'hours', default: 24 } }
  },
  'nat-gateway': {
    label: 'NAT gateway exists',
    description: 'Any NAT gateway, because they bill every hour and are easy to forget.',
    params: {}
  },
  'unattached-volume': {
    label: 'Unattached disk',
    description: 'An EBS volume attached to nothing.',
    params: {}
  },
  'unassociated-ip': {
    label: 'Unused Elastic IP',
    description: 'An Elastic IP attached to nothing.',
    params: {}
  },
  'gpu-instance': {
    label: 'GPU instance',
    description: 'A running GPU server or endpoint. These cost many times more than ordinary ones.',
    params: {}
  },
  'idle-cpu': {
    label: 'Idle server',
    description: 'A running server or database whose CPU stayed below the threshold for the whole window. Reads CloudWatch, which costs well under a cent per server per month.',
    params: {
      windowHours: { label: 'Window', unit: 'hours', default: 6 },
      maxCpuPercent: { label: 'CPU below', unit: '%', default: 2 }
    }
  },
  'stopped-storage': {
    label: 'Stopped but still paying for storage',
    description: 'A stopped server or database whose disks still bill.',
    params: {}
  },
  'rds-restarted': {
    label: 'Stopped database running again',
    description: 'A database that Cloud Watchdog stopped is running again. AWS starts a stopped database by itself after 7 days.',
    params: {}
  },
  'low-runway': {
    label: 'Credits running out',
    description: 'The credits or the plan end sooner than this.',
    params: { days: { label: 'Warn when fewer than', unit: 'days', default: 14 } }
  },
  'plan-expired': {
    label: 'Plan expired',
    description: 'The account plan has ended.',
    params: {}
  }
}
