import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adapters } from '../../src/adapters/registry.ts'
import type { SourceFile, SourceSystem } from '../../src/adapters/types.ts'
import { writeIngest } from '../../src/db/ingest.ts'
import { migrate } from '../../src/db/migrate.ts'
import { claimedBy } from '../../src/ingest/files.ts'
import { runAdapters, summarize } from '../../src/ingest/run.ts'
import { loadFixtureFiles, makeCtx } from '../unit/adapters/support.ts'

const FIXTURE_DIRS = ['jobber', 'housecall_pro', 'workiz', 'spreadsheet', 'calendars', 'profiles']

// The loader writes every candidate and issue with provenance, and a re-run replaces the last.
describe('ingest loader', () => {
  let container: StartedPostgreSqlContainer
  let client: pg.Client
  const files: SourceFile[] = FIXTURE_DIRS.flatMap((dir) => loadFixtureFiles(dir))
  const paths = files.map((file) => file.path)
  const claimed = new Map<SourceSystem, string[]>(
    adapters.map((adapter) => [adapter.sourceSystem, claimedBy(adapter, paths)]),
  )
  const ctx = makeCtx()

  function ingestOnce() {
    const results = runAdapters(
      adapters,
      claimed,
      (wanted) => files.filter((file) => wanted.includes(file.path)),
      ctx,
    )
    return { results, summary: summarize(results, []) }
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start()
    client = new pg.Client({ connectionString: container.getConnectionUri() })
    await client.connect()
    await migrate(client)
  })

  afterAll(async () => {
    await client.end()
    await container.stop()
  })

  it('claims every fixture file with exactly one adapter', () => {
    const all = [...claimed.values()].flat()
    expect(all.sort()).toEqual([...paths].sort())
  })

  it('stores every candidate with provenance from all six sources', async () => {
    const { results, summary } = ingestOnce()
    await writeIngest(client, ctx, results, summary)

    const systems = await client.query<{ source_system: string }>(
      'SELECT DISTINCT source_system FROM source_records ORDER BY 1',
    )
    expect(systems.rows.map((row) => row.source_system)).toEqual(
      [...adapters.map((adapter) => adapter.sourceSystem)].sort(),
    )
    const count = await client.query<{ n: string }>('SELECT count(*) AS n FROM source_records')
    expect(Number(count.rows[0]?.n)).toBe(summary.totals.records)

    const visit = await client.query<{ source_file: string; ingested_at: Date; status: string }>(
      `SELECT source_file, ingested_at, payload->>'status' AS status FROM source_records
       WHERE source_record_id = 'Z2lkOi8vSm9iYmVyL1Zpc2l0LzkwMDA0MDQ' AND record_type = 'job'`,
    )
    expect(visit.rows[0]?.source_file).toBe('sources/jobber/maple_leaf_plumbing.json')
    expect(visit.rows[0]?.ingested_at.toISOString()).toBe(new Date(ctx.ingestedAt).toISOString())
    expect(visit.rows[0]?.status).toBe('scheduled')

    const issues = await client.query<{ n: string }>('SELECT count(*) AS n FROM ingest_issues')
    expect(Number(issues.rows[0]?.n)).toBe(
      results.reduce((sum, result) => sum + result.batch.issues.length, 0),
    )
  })

  it('replaces the previous run, so a re-run leaves the same row counts', async () => {
    const before = await client.query<{ n: string }>('SELECT count(*) AS n FROM source_records')
    const { results, summary } = ingestOnce()
    await writeIngest(client, ctx, results, summary)
    const after = await client.query<{ n: string; runs: string }>(
      'SELECT count(*) AS n, (SELECT count(*) FROM ingest_runs) AS runs FROM source_records',
    )
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n)
    expect(after.rows[0]?.runs).toBe('1')
  })
})
