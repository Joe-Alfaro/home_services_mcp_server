import type pg from 'pg'
import type { AdapterContext } from '../adapters/types.ts'
import { candidatesOf, type IngestSummary, type SourceResult } from '../ingest/run.ts'

const CHUNK = 2000

function chunks<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  )
}

async function insertInChunks(
  client: pg.Client,
  sql: string,
  rows: readonly unknown[],
): Promise<void> {
  await chunks(rows, CHUNK).reduce(async (previous, chunk) => {
    await previous
    await client.query(sql, [JSON.stringify(chunk)])
  }, Promise.resolve())
}

/**
 * Replaces the previous ingest with this one in a single transaction (R22 b: re-running leaves
 * the same rows). Returns the new run id.
 */
export async function writeIngest(
  client: pg.Client,
  ctx: AdapterContext,
  results: readonly SourceResult[],
  summary: IngestSummary,
): Promise<number> {
  await client.query('BEGIN')
  try {
    await client.query('DELETE FROM ingest_runs')
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO ingest_runs (started_at, today, now, data_pack_dir, summary)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [ctx.ingestedAt, ctx.today, ctx.now, ctx.dataPackDir, JSON.stringify(summary)],
    )
    const runId = Number(rows[0]?.id)

    const records = results.flatMap(({ batch }) =>
      candidatesOf(batch).map((candidate) => ({
        ...candidate.ref,
        recordType: candidate.type,
        payload: candidate,
      })),
    )
    await insertInChunks(
      client,
      `INSERT INTO source_records (run_id, source_system, source_account, source_file,
         source_record_id, record_type, ingested_at, payload)
       SELECT ${String(runId)}, r."sourceSystem", r."sourceAccount", r."sourceFile",
         r."sourceRecordId", r."recordType", r."ingestedAt", r.payload
       FROM jsonb_to_recordset($1::jsonb) AS r("sourceSystem" text, "sourceAccount" text,
         "sourceFile" text, "sourceRecordId" text, "recordType" text, "ingestedAt" timestamptz,
         payload jsonb)`,
      records,
    )

    const issues = results.flatMap(({ batch }) =>
      batch.issues.map((issue) => ({
        ...issue.ref,
        severity: issue.severity,
        code: issue.code,
        message: issue.message,
      })),
    )
    await insertInChunks(
      client,
      `INSERT INTO ingest_issues (run_id, source_system, source_account, source_file,
         source_record_id, severity, code, message)
       SELECT ${String(runId)}, r."sourceSystem", r."sourceAccount", r."sourceFile",
         r."sourceRecordId", r.severity, r.code, r.message
       FROM jsonb_to_recordset($1::jsonb) AS r("sourceSystem" text, "sourceAccount" text,
         "sourceFile" text, "sourceRecordId" text, severity text, code text, message text)`,
      issues,
    )
    await client.query('COMMIT')
    return runId
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}
