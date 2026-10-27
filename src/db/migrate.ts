import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type pg from 'pg'
import { REPO_ROOT } from '../config.ts'

export const MIGRATIONS_DIR = path.join(REPO_ROOT, 'migrations')

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/

// Arbitrary constant so concurrent runners serialize instead of racing.
const LOCK_KEY = 4_861_337

export interface Migration {
  version: number
  name: string
  sql: string
}

export function readMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => {
      const match = MIGRATION_FILE.exec(file)
      if (!match?.[1]) throw new Error(`Bad migration file name: ${file} (want NNNN_name.sql)`)
      return {
        version: Number(match[1]),
        name: file,
        sql: readFileSync(path.join(dir, file), 'utf8'),
      }
    })
    .sort((a, b) => a.version - b.version)
}

/** Applies pending migrations in order, each in its own transaction. Returns the names applied. */
export async function migrate(client: pg.Client, migrations = readMigrations()): Promise<string[]> {
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY])
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    integer PRIMARY KEY,
        name       text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`)
    const { rows } = await client.query<{ version: number }>(
      'SELECT version FROM schema_migrations',
    )
    const applied = new Set(rows.map((row) => row.version))
    const pending = migrations.filter((migration) => !applied.has(migration.version))

    return await pending.reduce<Promise<string[]>>(async (done, migration) => {
      const names = await done
      await client.query('BEGIN')
      try {
        await client.query(migration.sql)
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
          migration.version,
          migration.name,
        ])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw new Error(`Migration ${migration.name} failed`, { cause: error })
      }
      return [...names, migration.name]
    }, Promise.resolve([]))
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY])
  }
}
