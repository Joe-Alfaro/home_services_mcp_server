import { readFileSync } from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { adapters } from '../adapters/registry.ts'
import type { AdapterContext, SourceSystem } from '../adapters/types.ts'
import { ingestTimestamp, TIME_ZONE } from '../config.ts'
import { clearCanonical, writeCanonical, writeStreetSegments } from '../db/canonical.ts'
import { insertIngest } from '../db/ingest.ts'
import { migrate } from '../db/migrate.ts'
import { createStreetIndex, parseStreetSegmentsCsv } from '../normalize/geocode.ts'
import { buildCanonical, type CanonicalModel } from './canonical.ts'
import { claimedBy, listSourcePaths, readSourceFiles } from './files.ts'
import { runAdapters, summarize, type IngestSummary } from './run.ts'

// ICS expansion window around "today" (ARCHITECTURE adapter contract defaults).
const HISTORY_DAYS = 731
const HORIZON_DAYS = 31

export const STREET_SEGMENTS_FILE = 'reference/street_segments.csv'

export interface PipelineOptions {
  dataPackDir: string
  databaseUrl: string
  /** "YYYY-MM-DD" in America/Chicago. */
  today: string
  /** UTC instant, e.g. "2026-11-02T06:00:00Z". */
  now: string
  /** Provenance timestamp of the run; defaults to ingestTimestamp() (R14). */
  ingestedAt?: string
}

/** Row counts of the canonical model, for the setup summary. */
export type CanonicalCounts = Record<keyof CanonicalModel, number>

export interface PipelineResult {
  runId: number
  summary: IngestSummary
  canonical: CanonicalCounts
  /** Link counts per table and method, e.g. { job_links: { duplicate_row: 12 } }. */
  linksByMethod: Record<string, Record<string, number>>
}

function countByMethod(links: readonly { method: string }[]): Record<string, number> {
  return links.reduce<Record<string, number>>((counts, link) => {
    counts[link.method] = (counts[link.method] ?? 0) + 1
    return counts
  }, {})
}

/**
 * The whole ingest (R1, R5-R11, R22): migrate, run every adapter over `<dataPackDir>/sources`,
 * normalize and resolve, then replace the previous run's source records and canonical rows in
 * one transaction. Re-running leaves the same rows. `today`/`now` come from the caller, never
 * the clock; the system time is used only as the provenance ingest timestamp.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const ctx: AdapterContext = {
    dataPackDir: options.dataPackDir,
    ingestedAt: options.ingestedAt ?? ingestTimestamp(),
    today: options.today,
    now: options.now,
    timeZone: TIME_ZONE,
    historyDays: HISTORY_DAYS,
    horizonDays: HORIZON_DAYS,
  }

  const paths = listSourcePaths(options.dataPackDir)
  const claimed = new Map<SourceSystem, string[]>(
    adapters.map((adapter) => [adapter.sourceSystem, claimedBy(adapter, paths)]),
  )
  const claimedPaths = new Set([...claimed.values()].flat())
  const unclaimed = paths.filter((filePath) => !claimedPaths.has(filePath))
  const results = runAdapters(
    adapters,
    claimed,
    (files) => readSourceFiles(options.dataPackDir, files),
    ctx,
  )
  const summary = summarize(results, unclaimed)

  const segments = parseStreetSegmentsCsv(
    readFileSync(path.join(options.dataPackDir, ...STREET_SEGMENTS_FILE.split('/')), 'utf8'),
  )
  const model = buildCanonical(
    results.map(({ batch }) => batch),
    createStreetIndex(segments),
  )

  const client = new pg.Client({ connectionString: options.databaseUrl })
  await client.connect()
  try {
    await migrate(client)
    await client.query('BEGIN')
    try {
      await clearCanonical(client)
      await client.query('DELETE FROM ingest_runs')
      const runId = await insertIngest(client, ctx, results, summary)
      await writeStreetSegments(client, segments)
      await writeCanonical(client, runId, model)
      await client.query('COMMIT')
      return {
        runId,
        summary,
        canonical: Object.fromEntries(
          Object.entries(model).map(([table, rows]: [string, readonly unknown[]]) => [
            table,
            rows.length,
          ]),
        ) as CanonicalCounts,
        linksByMethod: {
          provider_links: countByMethod(model.providerLinks),
          property_links: countByMethod(model.propertyLinks),
          job_links: countByMethod(model.jobLinks),
        },
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  } finally {
    await client.end()
  }
}
