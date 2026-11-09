// What every resource scanner looks like. A scanner does three things only:
// call the SDK paginator, map the responses to `Resource`, and throw on any
// error. It never catches, retries or prices. The scan engine (M3) owns
// concurrency, error classification, staleness and timeouts.

import type { Resource, ResourceKind } from '../../shared/types'
import type { ClientFactory } from '../aws/clients'

export interface ScanContext {
  accountId: string
  region: string
  clients: ClientFactory
  /** Aborted on quit, profile change or timeout. Pass it to every SDK call. */
  signal: AbortSignal
}

export interface Scanner {
  kind: ResourceKind
  /** Concurrency bucket, so one AWS service is not hit in every region at once. */
  service: 'ec2' | 'rds' | 'elb' | 'sagemaker'
  /** IAM actions this scanner calls. A test checks they are all in iam/*.json. */
  requiredActions: string[]
  scan(ctx: ScanContext): Promise<Resource[]>
}
