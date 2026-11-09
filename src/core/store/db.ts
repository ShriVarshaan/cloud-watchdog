// The only file that imports the SQLite driver. Everything else uses the
// small `Db` interface below, so swapping `node:sqlite` (built into Node and
// Electron, no native compile) for `better-sqlite3` would touch this file only.

import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'

export type SqlValue = string | number | bigint | null

export interface Db {
  /** Runs one or more statements that take no parameters (schema changes). */
  exec(sql: string): void
  /** Runs one statement. Returns how many rows it changed. */
  run(sql: string, ...params: SqlValue[]): number
  /** First row, or undefined when there is none. */
  get<Row = Record<string, SqlValue>>(sql: string, ...params: SqlValue[]): Row | undefined
  all<Row = Record<string, SqlValue>>(sql: string, ...params: SqlValue[]): Row[]
  /** Runs `fn` so that either all of its writes happen or none do. */
  transaction<T>(fn: () => T): T
  close(): void
}

/** Opens (and creates if needed) the database at `path`. Use ':memory:' in tests. */
export function openDb(path: string): Db {
  const sqlite = new DatabaseSync(path)
  sqlite.exec('PRAGMA journal_mode = WAL')
  sqlite.exec('PRAGMA synchronous = NORMAL')
  sqlite.exec('PRAGMA foreign_keys = ON')
  sqlite.exec('PRAGMA busy_timeout = 5000')

  // Compiling a statement is the slow part; each distinct SQL string is compiled once.
  const statements = new Map<string, StatementSync>()
  const prepare = (sql: string): StatementSync => {
    let statement = statements.get(sql)
    if (!statement) {
      statement = sqlite.prepare(sql)
      statements.set(sql, statement)
    }
    return statement
  }

  let inTransaction = false

  return {
    exec: (sql) => sqlite.exec(sql),

    run: (sql, ...params) => Number(prepare(sql).run(...(params as SQLInputValue[])).changes),

    get: <Row>(sql: string, ...params: SqlValue[]) =>
      prepare(sql).get(...(params as SQLInputValue[])) as Row | undefined,

    all: <Row>(sql: string, ...params: SqlValue[]) => prepare(sql).all(...(params as SQLInputValue[])) as Row[],

    transaction<T>(fn: () => T): T {
      // Already inside one: the outer transaction decides commit or rollback.
      if (inTransaction) return fn()
      sqlite.exec('BEGIN IMMEDIATE')
      inTransaction = true
      try {
        const result = fn()
        sqlite.exec('COMMIT')
        return result
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      } finally {
        inTransaction = false
      }
    },

    close(): void {
      statements.clear()
      sqlite.close()
    }
  }
}
