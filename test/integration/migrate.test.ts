import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate, readMigrations } from '../../src/db/migrate.ts'

// Each run gets a throwaway Postgres container, so integration tests never touch the dev DB.
describe('migrate', () => {
  let container: StartedPostgreSqlContainer
  let client: pg.Client

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start()
    client = new pg.Client({ connectionString: container.getConnectionUri() })
    await client.connect()
  })

  afterAll(async () => {
    await client.end()
    await container.stop()
  })

  it('applies every migration to an empty database', async () => {
    const expected = readMigrations().map((migration) => migration.name)
    expect(expected.length).toBeGreaterThan(0)

    expect(await migrate(client)).toEqual(expected)

    const { rows } = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY version',
    )
    expect(rows.map((row) => row.name)).toEqual(expected)
    const table = await client.query("SELECT to_regclass('public.source_records') AS t")
    expect(table.rows[0]).toEqual({ t: 'source_records' })
  })

  it('is a no-op the second time', async () => {
    expect(await migrate(client)).toEqual([])
  })

  it('rolls back a failing migration and records nothing for it', async () => {
    const broken = [{ version: 9999, name: '9999_broken.sql', sql: 'CREATE TABLE x (; ' }]
    await expect(migrate(client, broken)).rejects.toThrow(/9999_broken\.sql/)
    const { rowCount } = await client.query('SELECT 1 FROM schema_migrations WHERE version = 9999')
    expect(rowCount).toBe(0)
  })
})
