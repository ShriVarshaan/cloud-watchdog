// Reads and writes app data as typed objects. All SQL lives here; the rest
// of the app never sees a row. Later milestones add their own functions
// (price cache in M5, CPU cache in M7, action log in M10).

import type {
  AttrValue,
  Flag,
  Identity,
  PlanState,
  PricedResource,
  ScanError,
  ScanResult
} from '../../shared/types'
import type { Db } from './db'

/** What is stored per scan. Flags, plan and runway are stored separately. */
export type StoredScan = Pick<ScanResult, 'scanId' | 'startedAt' | 'finishedAt' | 'identity' | 'burn' | 'errors' | 'resources'>

export interface Repo {
  /** Saves a finished scan and makes its resources the current state. All or nothing. */
  saveScan(scan: ScanResult): void
  getLatestScan(accountId: string): StoredScan | null
  getResourceTimes(resourceKey: string): { firstSeenAt: string; lastSeenAt: string } | null
  /** Deletes scans (and their history rows) that started before `cutoff`. Returns how many. */
  pruneScansBefore(cutoff: string): number

  /** Inserts or overwrites a flag. `firstSeenAt` of an existing flag is kept. */
  upsertFlag(accountId: string, flag: Flag, seenAt: string): void
  listFlags(accountId: string, options?: { includeResolved?: boolean }): Flag[]
  /** `until: null` clears the dismissal. Returns false when the flag does not exist. */
  setFlagDismissedUntil(flagId: string, until: string | null): boolean

  addPlanSnapshot(accountId: string, plan: PlanState): void
  getLatestPlanSnapshot(accountId: string): PlanState | null

  /** A public list price fetched earlier, however old. The caller decides whether it is still fresh. */
  getCachedPrice(priceKey: string): CachedPrice | null
  putCachedPrice(priceKey: string, price: { unitUsd: number; sku: string | null }, fetchedAt: string): void

  /** The last CPU reading taken for a resource, whatever window it was for. */
  getCpuReading(resourceKey: string): StoredCpuReading | null
  putCpuReading(resourceKey: string, reading: StoredCpuReading): void
}

export interface StoredCpuReading {
  /** Highest CPU percentage in the window. null = CloudWatch had no datapoints. */
  maxCpu: number | null
  datapoints: number
  /** ISO time the measured window ended at. */
  windowEnd: string
}

export interface CachedPrice {
  /** USD per unit. The unit (hour, GB-month, ...) is part of the price key. */
  unitUsd: number
  sku: string | null
  fetchedAt: string
}

type ScanRow = {
  id: string
  account_id: string
  arn: string
  profile: string
  started_at: string
  finished_at: string
  burn_exact: number
  burn_estimate: number
  unknown_count: number
}

type ResourceRow = {
  key: string
  kind: PricedResource['kind']
  region: string
  id: string
  name: string | null
  state: string
  created_at: string | null
  attrs_json: string
  hourly_usd: number | null
  confidence: PricedResource['price']['confidence']
  price_source: PricedResource['price']['source']
  excluded_json: string
  coverage: PricedResource['coverage']
  stale: number
}

type FlagRow = {
  id: string
  rule_id: string
  resource_key: string | null
  severity: Flag['severity']
  message: string
  first_seen_at: string
  resolved_at: string | null
  dismissed_until: string | null
}

type PlanRow = {
  fetched_at: string
  plan_type: PlanState['planType']
  status: PlanState['status']
  remaining_credits_usd: number | null
  expires_at: string | null
}

function toResource(row: ResourceRow): PricedResource {
  return {
    key: row.key,
    kind: row.kind,
    region: row.region,
    id: row.id,
    ...(row.name !== null ? { name: row.name } : {}),
    state: row.state,
    ...(row.created_at !== null ? { createdAt: row.created_at } : {}),
    attrs: JSON.parse(row.attrs_json) as Record<string, AttrValue>,
    price: {
      hourlyUsd: row.hourly_usd,
      confidence: row.confidence,
      source: row.price_source,
      excluded: JSON.parse(row.excluded_json) as string[]
    },
    coverage: row.coverage,
    stale: row.stale === 1
  }
}

function toFlag(row: FlagRow): Flag {
  return {
    id: row.id,
    ruleId: row.rule_id,
    resourceKey: row.resource_key,
    severity: row.severity,
    message: row.message,
    firstSeenAt: row.first_seen_at,
    ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
    ...(row.dismissed_until !== null ? { dismissedUntil: row.dismissed_until } : {})
  }
}

export function createRepo(db: Db): Repo {
  return {
    saveScan(scan) {
      const accountId = scan.identity.accountId
      const foreign = scan.resources.find((resource) => !resource.key.startsWith(`${accountId}:`))
      if (foreign) throw new Error(`Resource ${foreign.id} does not belong to account ${accountId}.`)

      db.transaction(() => {
        db.run(
          `INSERT INTO scans (id, account_id, arn, profile, started_at, finished_at,
                              burn_exact, burn_estimate, unknown_count, error_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          scan.scanId,
          accountId,
          scan.identity.arn,
          scan.identity.profile,
          scan.startedAt,
          scan.finishedAt,
          scan.burn.exactUsdPerHour,
          scan.burn.estimateUsdPerHour,
          scan.burn.unknownCount,
          scan.errors.length
        )

        for (const error of scan.errors) {
          db.run(
            'INSERT INTO scan_errors (scan_id, scanner, region, code, message) VALUES (?, ?, ?, ?, ?)',
            scan.scanId,
            error.scanner,
            error.region,
            error.code,
            error.message
          )
        }

        for (const resource of scan.resources) {
          // A stale resource was not looked at in this scan: it stays in the
          // current state, but its last-seen time does not move.
          db.run(
            `INSERT INTO resources (key, account_id, kind, region, id, name, state, created_at, attrs_json,
                                    hourly_usd, confidence, price_source, excluded_json, coverage,
                                    first_seen_at, last_seen_at, last_scan_id, stale)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (key) DO UPDATE SET
               name = excluded.name,
               state = excluded.state,
               created_at = excluded.created_at,
               attrs_json = excluded.attrs_json,
               hourly_usd = excluded.hourly_usd,
               confidence = excluded.confidence,
               price_source = excluded.price_source,
               excluded_json = excluded.excluded_json,
               coverage = excluded.coverage,
               last_seen_at = CASE WHEN excluded.stale = 1 THEN resources.last_seen_at ELSE excluded.last_seen_at END,
               last_scan_id = excluded.last_scan_id,
               stale = excluded.stale`,
            resource.key,
            accountId,
            resource.kind,
            resource.region,
            resource.id,
            resource.name ?? null,
            resource.state,
            resource.createdAt ?? null,
            JSON.stringify(resource.attrs),
            resource.price.hourlyUsd,
            resource.price.confidence,
            resource.price.source,
            JSON.stringify(resource.price.excluded),
            resource.coverage,
            scan.startedAt,
            scan.startedAt,
            scan.scanId,
            resource.stale ? 1 : 0
          )

          db.run(
            `INSERT INTO observations (scan_id, resource_key, state, hourly_usd, confidence, coverage)
             VALUES (?, ?, ?, ?, ?, ?)`,
            scan.scanId,
            resource.key,
            resource.state,
            resource.price.hourlyUsd,
            resource.price.confidence,
            resource.coverage
          )
        }

        // Anything of this account that is not in this scan no longer exists.
        db.run('DELETE FROM resources WHERE account_id = ? AND last_scan_id <> ?', accountId, scan.scanId)
      })
    },

    getLatestScan(accountId) {
      const row = db.get<ScanRow>(
        `SELECT id, account_id, arn, profile, started_at, finished_at, burn_exact, burn_estimate, unknown_count
         FROM scans WHERE account_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
        accountId
      )
      if (!row) return null

      const identity: Identity = { accountId: row.account_id, arn: row.arn, profile: row.profile }
      const errors = db.all<ScanError>(
        'SELECT scanner, region, code, message FROM scan_errors WHERE scan_id = ? ORDER BY rowid',
        row.id
      )
      const resources = db.all<ResourceRow>(
        `SELECT key, kind, region, id, name, state, created_at, attrs_json,
                hourly_usd, confidence, price_source, excluded_json, coverage, stale
         FROM resources WHERE account_id = ? AND last_scan_id = ? ORDER BY key`,
        accountId,
        row.id
      )
      return {
        scanId: row.id,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        identity,
        burn: {
          exactUsdPerHour: row.burn_exact,
          estimateUsdPerHour: row.burn_estimate,
          unknownCount: row.unknown_count
        },
        errors: errors.map((error) => ({ ...error })),
        resources: resources.map(toResource)
      }
    },

    getResourceTimes(resourceKey) {
      const row = db.get<{ first_seen_at: string; last_seen_at: string }>(
        'SELECT first_seen_at, last_seen_at FROM resources WHERE key = ?',
        resourceKey
      )
      return row ? { firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at } : null
    },

    pruneScansBefore(cutoff) {
      return db.transaction(() => {
        // scan_errors and observations go with their scan (ON DELETE CASCADE).
        const removed = db.run('DELETE FROM scans WHERE started_at < ?', cutoff)
        db.run('DELETE FROM resources WHERE last_scan_id NOT IN (SELECT id FROM scans)')
        return removed
      })
    },

    upsertFlag(accountId, flag, seenAt) {
      db.run(
        `INSERT INTO flags (id, account_id, rule_id, resource_key, severity, message,
                            first_seen_at, last_seen_at, resolved_at, dismissed_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           severity = excluded.severity,
           message = excluded.message,
           last_seen_at = excluded.last_seen_at,
           resolved_at = excluded.resolved_at,
           dismissed_until = excluded.dismissed_until`,
        flag.id,
        accountId,
        flag.ruleId,
        flag.resourceKey,
        flag.severity,
        flag.message,
        flag.firstSeenAt,
        seenAt,
        flag.resolvedAt ?? null,
        flag.dismissedUntil ?? null
      )
    },

    listFlags(accountId, options = {}) {
      const rows = db.all<FlagRow>(
        `SELECT id, rule_id, resource_key, severity, message, first_seen_at, resolved_at, dismissed_until
         FROM flags
         WHERE account_id = ? AND (? = 1 OR resolved_at IS NULL)
         ORDER BY first_seen_at, id`,
        accountId,
        options.includeResolved ? 1 : 0
      )
      return rows.map(toFlag)
    },

    setFlagDismissedUntil(flagId, until) {
      return db.run('UPDATE flags SET dismissed_until = ? WHERE id = ?', until, flagId) > 0
    },

    addPlanSnapshot(accountId, plan) {
      db.run(
        `INSERT INTO plan_snapshots (account_id, fetched_at, plan_type, status, remaining_credits_usd, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        accountId,
        plan.fetchedAt,
        plan.planType,
        plan.status,
        plan.remainingCreditsUsd,
        plan.expiresAt
      )
    },

    getLatestPlanSnapshot(accountId) {
      const row = db.get<PlanRow>(
        `SELECT fetched_at, plan_type, status, remaining_credits_usd, expires_at
         FROM plan_snapshots WHERE account_id = ? ORDER BY fetched_at DESC, rowid DESC LIMIT 1`,
        accountId
      )
      if (!row) return null
      return {
        planType: row.plan_type,
        status: row.status,
        remainingCreditsUsd: row.remaining_credits_usd,
        expiresAt: row.expires_at,
        fetchedAt: row.fetched_at
      }
    },

    getCachedPrice(priceKey) {
      const row = db.get<{ unit_usd: number; sku: string | null; fetched_at: string }>(
        'SELECT unit_usd, sku, fetched_at FROM price_cache WHERE price_key = ?',
        priceKey
      )
      return row ? { unitUsd: row.unit_usd, sku: row.sku, fetchedAt: row.fetched_at } : null
    },

    putCachedPrice(priceKey, price, fetchedAt) {
      db.run(
        `INSERT INTO price_cache (price_key, unit_usd, sku, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (price_key) DO UPDATE SET
           unit_usd = excluded.unit_usd,
           sku = excluded.sku,
           fetched_at = excluded.fetched_at`,
        priceKey,
        price.unitUsd,
        price.sku,
        fetchedAt
      )
    },

    getCpuReading(resourceKey) {
      const row = db.get<{ window_end: string; max_cpu: number | null; datapoints: number }>(
        'SELECT window_end, max_cpu, datapoints FROM cpu_cache WHERE resource_key = ?',
        resourceKey
      )
      return row ? { maxCpu: row.max_cpu, datapoints: row.datapoints, windowEnd: row.window_end } : null
    },

    putCpuReading(resourceKey, reading) {
      db.run(
        `INSERT INTO cpu_cache (resource_key, window_end, max_cpu, datapoints) VALUES (?, ?, ?, ?)
         ON CONFLICT (resource_key) DO UPDATE SET
           window_end = excluded.window_end,
           max_cpu = excluded.max_cpu,
           datapoints = excluded.datapoints`,
        resourceKey,
        reading.windowEnd,
        reading.maxCpu,
        reading.datapoints
      )
    }
  }
}
