// The link between the scan engine and the store: what the last saved scan
// ended with, which the engine carries forward when a task fails. Pricing,
// coverage, rules and saving happen in pipeline.ts.

import type { Resource } from '../../shared/types'
import type { Repo } from '../store/repo'

export function previousResourcesFrom(repo: Repo): (accountId: string) => readonly Resource[] {
  return (accountId) => repo.getLatestScan(accountId)?.resources ?? []
}
