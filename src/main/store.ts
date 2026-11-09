// Opens the app's SQLite database in the user-data folder
// (%APPDATA%/Cloud Watchdog/watchdog.db) and brings its schema up to date.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb, type Db } from '../core/store/db'
import { migrate } from '../core/store/migrations'

export const DB_FILE_NAME = 'watchdog.db'

export function openStore(userDataDir: string): Db {
  mkdirSync(userDataDir, { recursive: true })
  const db = openDb(join(userDataDir, DB_FILE_NAME))
  try {
    migrate(db)
  } catch (error) {
    db.close()
    throw error
  }
  return db
}
