import { beforeEach, describe, expect, it } from 'vitest'
import type { Flag, PlanState, PricedResource, ScanResult } from '../../shared/types'
import { openDb, type Db } from './db'
import { migrate, MIGRATIONS, SCHEMA_VERSION } from './migrations'
import { createRepo, type Repo } from './repo'

const ACCOUNT = '111122223333'

function resource(id: string, overrides: Partial<PricedResource> = {}): PricedResource {
  return {
    key: `${ACCOUNT}:ec2-instance:eu-west-1:${id}`,
    kind: 'ec2-instance',
    region: 'eu-west-1',
    id,
    name: `web-${id}`,
    state: 'running',
    createdAt: '2026-11-01T10:00:00.000Z',
    attrs: { instanceType: 't3.micro', vcpus: 2, spot: false, platform: null },
    price: { hourlyUsd: 0.0114, confidence: 'exact', source: 'price-list-api', excluded: ['Data transfer'] },
    coverage: 'covered',
    stale: false,
    ...overrides
  }
}

function scan(scanId: string, startedAt: string, resources: PricedResource[], overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    scanId,
    startedAt,
    finishedAt: startedAt.replace(':00.000Z', ':30.000Z'),
    identity: { accountId: ACCOUNT, arn: `arn:aws:iam::${ACCOUNT}:user/watchdog`, profile: 'hackathon' },
    resources,
    flags: [],
    errors: [],
    burn: { exactUsdPerHour: 0.0114, estimateUsdPerHour: 0.002, unknownCount: 1 },
    plan: null,
    runway: null,
    ...overrides
  }
}

let db: Db
let repo: Repo

beforeEach(() => {
  db = openDb(':memory:')
  migrate(db)
  repo = createRepo(db)
})

describe('migrations', () => {
  it('creates every table and records the schema version', () => {
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .map((row) => row.name)
    expect(tables).toEqual([
      'action_log',
      'cpu_cache',
      'flags',
      'meta',
      'observations',
      'plan_snapshots',
      'price_cache',
      'resources',
      'scan_errors',
      'scans'
    ])
    expect(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value).toBe(
      String(SCHEMA_VERSION)
    )
  })

  it('is safe to run again and keeps existing data', () => {
    repo.saveScan(scan('s1', '2026-11-09T10:00:00.000Z', [resource('i-1')]))
    expect(migrate(db)).toBe(0)
    expect(repo.getLatestScan(ACCOUNT)?.resources).toHaveLength(1)
  })

  it('reports how many migrations it applied to a fresh database', () => {
    const fresh = openDb(':memory:')
    expect(migrate(fresh)).toBe(MIGRATIONS.length)
    fresh.close()
  })

  it('refuses a database written by a newer version of the app', () => {
    db.run("UPDATE meta SET value = ? WHERE key = 'schema_version'", String(SCHEMA_VERSION + 1))
    expect(() => migrate(db)).toThrow(/newer version/i)
  })

  it('rolls a failed migration back completely', () => {
    const fresh = openDb(':memory:')
    const broken = [...MIGRATIONS, { version: SCHEMA_VERSION + 1, sql: 'CREATE TABLE extra(x); THIS IS NOT SQL;' }]
    expect(() => migrate(fresh, broken)).toThrow()
    const extra = fresh.get("SELECT name FROM sqlite_master WHERE name = 'extra'")
    expect(extra).toBeUndefined()
    expect(fresh.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value).toBe(
      String(SCHEMA_VERSION)
    )
    fresh.close()
  })

  it('has strictly increasing version numbers starting at 1', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1))
  })

  it('enforces foreign keys', () => {
    expect(() =>
      db.run(
        "INSERT INTO scan_errors(scan_id, scanner, region, code, message) VALUES ('missing', 'regions', NULL, 'unknown', 'x')"
      )
    ).toThrow(/foreign key/i)
  })
})

describe('db', () => {
  it('rolls back a transaction that throws and rethrows the error', () => {
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO meta(key, value) VALUES ('temp', '1')")
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(db.get("SELECT value FROM meta WHERE key = 'temp'")).toBeUndefined()
  })

  it('returns the value of a transaction that succeeds', () => {
    expect(db.transaction(() => 42)).toBe(42)
  })
})

describe('repo: scans and resources', () => {
  it('returns null before any scan', () => {
    expect(repo.getLatestScan(ACCOUNT)).toBeNull()
  })

  it('round-trips a scan with resources and errors', () => {
    const unpriced = resource('i-2', {
      price: { hourlyUsd: null, confidence: 'unknown', source: 'none', excluded: [] },
      coverage: 'unknown'
    })
    delete unpriced.name
    delete unpriced.createdAt
    const input = scan('s1', '2026-11-09T10:00:00.000Z', [resource('i-1'), unpriced], {
      errors: [
        { scanner: 'rds-instance', region: 'us-east-1', code: 'access-denied', message: 'not authorized' },
        { scanner: 'freetier', region: null, code: 'throttled', message: 'slow down' }
      ]
    })
    repo.saveScan(input)

    const stored = repo.getLatestScan(ACCOUNT)
    expect(stored).toEqual({
      scanId: input.scanId,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      identity: input.identity,
      burn: input.burn,
      errors: input.errors,
      resources: input.resources
    })
  })

  it('returns the most recent scan and only its resources', () => {
    repo.saveScan(scan('s1', '2026-11-09T10:00:00.000Z', [resource('i-1'), resource('i-gone')]))
    repo.saveScan(scan('s2', '2026-11-09T10:15:00.000Z', [resource('i-1', { state: 'stopped' })]))
    const stored = repo.getLatestScan(ACCOUNT)
    expect(stored?.scanId).toBe('s2')
    expect(stored?.resources.map((r) => [r.id, r.state])).toEqual([['i-1', 'stopped']])
  })

  it('keeps first-seen time across scans and moves last-seen forward', () => {
    repo.saveScan(scan('s1', '2026-11-09T10:00:00.000Z', [resource('i-1')]))
    repo.saveScan(scan('s2', '2026-11-09T10:15:00.000Z', [resource('i-1')]))
    expect(repo.getResourceTimes(`${ACCOUNT}:ec2-instance:eu-west-1:i-1`)).toEqual({
      firstSeenAt: '2026-11-09T10:00:00.000Z',
      lastSeenAt: '2026-11-09T10:15:00.000Z'
    })
  })

  it('does not move last-seen forward for a stale resource', () => {
    repo.saveScan(scan('s1', '2026-11-09T10:00:00.000Z', [resource('i-1')]))
    repo.saveScan(scan('s2', '2026-11-09T10:15:00.000Z', [resource('i-1', { stale: true })]))
    expect(repo.getLatestScan(ACCOUNT)?.resources[0]?.stale).toBe(true)
    expect(repo.getResourceTimes(`${ACCOUNT}:ec2-instance:eu-west-1:i-1`)?.lastSeenAt).toBe('2026-11-09T10:00:00.000Z')
  })

  it('keeps accounts apart', () => {
    const other = '999988887777'
    repo.saveScan(scan('s1', '2026-11-09T10:00:00.000Z', [resource('i-1')]))
    repo.saveScan(
      scan('s2', '2026-11-09T10:15:00.000Z', [resource('i-9', { key: `${other}:ec2-instance:eu-west-1:i-9` })], {
        identity: { accountId: other, arn: `arn:aws:iam::${other}:root`, profile: 'other' }
      })
    )
    expect(repo.getLatestScan(ACCOUNT)?.resources.map((r) => r.id)).toEqual(['i-1'])
    expect(repo.getLatestScan(other)?.resources.map((r) => r.id)).toEqual(['i-9'])
  })

  it('refuses a resource whose key belongs to another account', () => {
    const foreign = resource('i-x', { key: '999988887777:ec2-instance:eu-west-1:i-x' })
    expect(() => repo.saveScan(scan('s1', '2026-11-09T10:00:00.000Z', [foreign]))).toThrow(/account/i)
    expect(repo.getLatestScan(ACCOUNT)).toBeNull()
  })

  it('writes one observation per resource per scan and prunes old scans with them', () => {
    repo.saveScan(scan('old', '2026-10-01T10:00:00.000Z', [resource('i-1')]))
    repo.saveScan(scan('new', '2026-11-09T10:00:00.000Z', [resource('i-1'), resource('i-2')]))
    const count = () => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM observations')?.n
    expect(count()).toBe(3)

    expect(repo.pruneScansBefore('2026-10-10T00:00:00.000Z')).toBe(1)
    expect(count()).toBe(2)
    expect(repo.getLatestScan(ACCOUNT)?.scanId).toBe('new')
  })
})

describe('repo: flags', () => {
  const flag = (overrides: Partial<Flag> = {}): Flag => ({
    id: 'f1',
    ruleId: 'nat-gateway',
    resourceKey: `${ACCOUNT}:nat-gateway:eu-west-1:nat-1`,
    severity: 'warn',
    message: 'A NAT gateway is running',
    firstSeenAt: '2026-11-09T10:00:00.000Z',
    ...overrides
  })

  it('round-trips resource and account-level flags', () => {
    const accountFlag = flag({ id: 'f2', ruleId: 'runway-low', resourceKey: null, severity: 'critical' })
    repo.upsertFlag(ACCOUNT, flag(), '2026-11-09T10:00:00.000Z')
    repo.upsertFlag(ACCOUNT, accountFlag, '2026-11-09T10:00:00.000Z')
    expect(repo.listFlags(ACCOUNT)).toEqual([flag(), accountFlag])
  })

  it('updates an existing flag without changing when it was first seen', () => {
    repo.upsertFlag(ACCOUNT, flag(), '2026-11-09T10:00:00.000Z')
    repo.upsertFlag(
      ACCOUNT,
      flag({ message: 'Still running', firstSeenAt: '2026-11-09T11:00:00.000Z' }),
      '2026-11-09T11:00:00.000Z'
    )
    expect(repo.listFlags(ACCOUNT)).toEqual([flag({ message: 'Still running' })])
  })

  it('hides resolved flags unless asked', () => {
    repo.upsertFlag(ACCOUNT, flag({ resolvedAt: '2026-11-09T12:00:00.000Z' }), '2026-11-09T12:00:00.000Z')
    expect(repo.listFlags(ACCOUNT)).toEqual([])
    expect(repo.listFlags(ACCOUNT, { includeResolved: true })).toHaveLength(1)
  })

  it('sets and clears a dismissal, and reports an unknown flag', () => {
    repo.upsertFlag(ACCOUNT, flag(), '2026-11-09T10:00:00.000Z')
    expect(repo.setFlagDismissedUntil('f1', '2026-11-10T10:00:00.000Z')).toBe(true)
    expect(repo.listFlags(ACCOUNT)[0]?.dismissedUntil).toBe('2026-11-10T10:00:00.000Z')
    expect(repo.setFlagDismissedUntil('f1', null)).toBe(true)
    expect(repo.listFlags(ACCOUNT)[0]).not.toHaveProperty('dismissedUntil')
    expect(repo.setFlagDismissedUntil('nope', null)).toBe(false)
  })

  it('keeps flags of different accounts apart', () => {
    repo.upsertFlag(ACCOUNT, flag(), '2026-11-09T10:00:00.000Z')
    expect(repo.listFlags('999988887777')).toEqual([])
  })
})

describe('repo: plan snapshots', () => {
  const plan = (overrides: Partial<PlanState> = {}): PlanState => ({
    planType: 'FREE',
    status: 'ACTIVE',
    remainingCreditsUsd: 87.5,
    expiresAt: '2027-03-01T00:00:00.000Z',
    fetchedAt: '2026-11-09T10:00:00.000Z',
    ...overrides
  })

  it('returns null when there is none', () => {
    expect(repo.getLatestPlanSnapshot(ACCOUNT)).toBeNull()
  })

  it('round-trips the latest snapshot, including unknown credits and expiry', () => {
    repo.addPlanSnapshot(ACCOUNT, plan())
    const later = plan({ remainingCreditsUsd: null, expiresAt: null, planType: 'PAID', fetchedAt: '2026-11-09T11:00:00.000Z' })
    repo.addPlanSnapshot(ACCOUNT, later)
    expect(repo.getLatestPlanSnapshot(ACCOUNT)).toEqual(later)
    expect(repo.getLatestPlanSnapshot('999988887777')).toBeNull()
  })
})

describe('repo: price cache', () => {
  const KEY = 'AmazonEC2|instanceType=t3.micro&regionCode=eu-west-1|BoxUsage:t3.micro|hour'

  it('returns null for a price that was never stored', () => {
    expect(repo.getCachedPrice(KEY)).toBeNull()
  })

  it('round-trips a unit price with its SKU and fetch time', () => {
    repo.putCachedPrice(KEY, { unitUsd: 0.0114, sku: 'ABCDEFGH12345678' }, '2026-11-10T09:00:00.000Z')
    expect(repo.getCachedPrice(KEY)).toEqual({
      unitUsd: 0.0114,
      sku: 'ABCDEFGH12345678',
      fetchedAt: '2026-11-10T09:00:00.000Z'
    })
  })

  it('replaces the stored price when it is fetched again', () => {
    repo.putCachedPrice(KEY, { unitUsd: 0.0114, sku: 'OLD' }, '2026-11-01T09:00:00.000Z')
    repo.putCachedPrice(KEY, { unitUsd: 0.012, sku: null }, '2026-11-10T09:00:00.000Z')
    expect(repo.getCachedPrice(KEY)).toEqual({ unitUsd: 0.012, sku: null, fetchedAt: '2026-11-10T09:00:00.000Z' })
  })

  it('keeps prices cached by the first schema version', () => {
    const old = openDb(':memory:')
    migrate(old, MIGRATIONS.slice(0, 1))
    old.run("INSERT INTO price_cache (price_key, hourly_usd, sku, fetched_at) VALUES (?, 0.045, 'SKU1', '2026-11-09T00:00:00.000Z')", KEY)

    migrate(old)
    expect(createRepo(old).getCachedPrice(KEY)).toEqual({ unitUsd: 0.045, sku: 'SKU1', fetchedAt: '2026-11-09T00:00:00.000Z' })
    old.close()
  })
})
