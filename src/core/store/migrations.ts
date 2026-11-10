// Database schema, as a list of numbered steps. A database remembers the
// last step it ran (meta.schema_version); on start the app runs the steps
// after that. Rules:
//   - never edit a migration that has shipped; add a new one
//   - each migration runs in a transaction, so a failure leaves the database
//     exactly as it was
//
// No credentials, tokens or secrets are stored in any table.

import type { Db } from './db'

export interface Migration {
  version: number
  sql: string
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      -- One row per completed scan.
      CREATE TABLE scans (
        id            TEXT PRIMARY KEY,
        account_id    TEXT NOT NULL,
        arn           TEXT NOT NULL,
        profile       TEXT NOT NULL,
        started_at    TEXT NOT NULL,
        finished_at   TEXT NOT NULL,
        burn_exact    REAL NOT NULL,
        burn_estimate REAL NOT NULL,
        unknown_count INTEGER NOT NULL,
        error_count   INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX scans_by_account ON scans (account_id, started_at);

      -- What failed during a scan (one row per scanner and region).
      CREATE TABLE scan_errors (
        scan_id TEXT NOT NULL REFERENCES scans (id) ON DELETE CASCADE,
        scanner TEXT NOT NULL,
        region  TEXT,
        code    TEXT NOT NULL,
        message TEXT NOT NULL
      ) STRICT;
      CREATE INDEX scan_errors_by_scan ON scan_errors (scan_id);

      -- Current state: one row per resource that exists (or, when stale = 1,
      -- that existed the last time its region could be looked at).
      CREATE TABLE resources (
        key           TEXT PRIMARY KEY,
        account_id    TEXT NOT NULL,
        kind          TEXT NOT NULL,
        region        TEXT NOT NULL,
        id            TEXT NOT NULL,
        name          TEXT,
        state         TEXT NOT NULL,
        created_at    TEXT,
        attrs_json    TEXT NOT NULL,
        hourly_usd    REAL,
        confidence    TEXT NOT NULL,
        price_source  TEXT NOT NULL,
        excluded_json TEXT NOT NULL,
        coverage      TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at  TEXT NOT NULL,
        last_scan_id  TEXT NOT NULL,
        stale         INTEGER NOT NULL DEFAULT 0,
        CHECK ((confidence = 'unknown') = (hourly_usd IS NULL))
      ) STRICT;
      CREATE INDEX resources_by_account ON resources (account_id, last_scan_id);

      -- History: what each resource looked like and cost in each scan.
      CREATE TABLE observations (
        scan_id      TEXT NOT NULL REFERENCES scans (id) ON DELETE CASCADE,
        resource_key TEXT NOT NULL,
        state        TEXT NOT NULL,
        hourly_usd   REAL,
        confidence   TEXT NOT NULL,
        coverage     TEXT NOT NULL,
        PRIMARY KEY (scan_id, resource_key)
      ) STRICT, WITHOUT ROWID;

      -- Warnings raised by rules. resource_key NULL = about the whole account.
      CREATE TABLE flags (
        id              TEXT PRIMARY KEY,
        account_id      TEXT NOT NULL,
        rule_id         TEXT NOT NULL,
        resource_key    TEXT,
        severity        TEXT NOT NULL,
        message         TEXT NOT NULL,
        first_seen_at   TEXT NOT NULL,
        last_seen_at    TEXT NOT NULL,
        resolved_at     TEXT,
        notified_at     TEXT,
        dismissed_until TEXT
      ) STRICT;
      CREATE INDEX flags_by_account ON flags (account_id, resolved_at);

      -- Public list prices, refetched after 7 days.
      CREATE TABLE price_cache (
        price_key  TEXT PRIMARY KEY,
        hourly_usd REAL NOT NULL,
        sku        TEXT,
        fetched_at TEXT NOT NULL
      ) STRICT;

      -- Free-plan and credit state each time it was fetched.
      CREATE TABLE plan_snapshots (
        account_id            TEXT NOT NULL,
        fetched_at            TEXT NOT NULL,
        plan_type             TEXT NOT NULL,
        status                TEXT NOT NULL,
        remaining_credits_usd REAL,
        expires_at            TEXT
      ) STRICT;
      CREATE INDEX plan_snapshots_by_account ON plan_snapshots (account_id, fetched_at);

      -- Last CPU reading per resource, so CloudWatch is asked at most hourly.
      CREATE TABLE cpu_cache (
        resource_key TEXT PRIMARY KEY,
        window_end   TEXT NOT NULL,
        max_cpu      REAL,
        datapoints   INTEGER NOT NULL
      ) STRICT;

      -- Every attempt to stop something, whether it worked or not.
      CREATE TABLE action_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        at           TEXT NOT NULL,
        account_id   TEXT NOT NULL,
        resource_key TEXT NOT NULL,
        action       TEXT NOT NULL,
        pre_state    TEXT,
        result       TEXT NOT NULL,
        error        TEXT
      ) STRICT;
    `
  },
  {
    // The cache holds one price per unit, and not every unit is an hour
    // (storage is priced per GB-month). The unit is part of price_key.
    version: 2,
    sql: 'ALTER TABLE price_cache RENAME COLUMN hourly_usd TO unit_usd;'
  }
]

export const SCHEMA_VERSION = MIGRATIONS.length

function currentVersion(db: Db): number {
  const hasMeta = db.get("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
  if (!hasMeta) return 0
  const row = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")
  return row ? Number(row.value) : 0
}

/** Brings the database up to date. Returns how many migrations were applied. */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): number {
  const latest = migrations.length
  const from = currentVersion(db)
  if (!Number.isInteger(from) || from < 0) throw new Error(`The database has an invalid schema version: ${from}`)
  if (from > latest) {
    throw new Error(
      `The database was written by a newer version of Cloud Watchdog (schema ${from}, this app understands ${latest}).`
    )
  }

  const pending = migrations.filter((migration) => migration.version > from)
  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.sql)
      db.run(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        String(migration.version)
      )
    })
  }
  return pending.length
}
