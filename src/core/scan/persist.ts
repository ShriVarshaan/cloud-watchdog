// The link between the scan engine and the store.
//
//   previousResourcesFrom  what the last saved scan ended with, which the
//                          engine carries forward when a task fails
//   toUnpricedScanResult   a RawScan in the shape the store saves
//
// Until pricing (M5), free-tier coverage (M6) and rules (M7) exist, a saved
// scan says honestly that it knows no prices: every price is 'unknown' and
// shown as "—", never as $0. Those milestones replace toUnpricedScanResult
// with the real pipeline.

import type { Price, Resource, ScanResult } from '../../shared/types'
import type { Repo } from '../store/repo'
import type { RawScan } from './engine'

const UNKNOWN_PRICE: Price = { hourlyUsd: null, confidence: 'unknown', source: 'none', excluded: [] }

export function previousResourcesFrom(repo: Repo): (accountId: string) => readonly Resource[] {
  return (accountId) => repo.getLatestScan(accountId)?.resources ?? []
}

export function toUnpricedScanResult(raw: RawScan): ScanResult {
  return {
    scanId: raw.scanId,
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
    identity: raw.identity,
    resources: raw.resources.map((resource) => ({
      ...resource,
      price: { ...UNKNOWN_PRICE, excluded: [] },
      coverage: 'unknown'
    })),
    flags: [],
    errors: raw.errors,
    burn: { exactUsdPerHour: 0, estimateUsdPerHour: 0, unknownCount: raw.resources.length },
    plan: null,
    runway: null
  }
}
