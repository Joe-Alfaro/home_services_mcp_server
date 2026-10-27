import { existsSync } from 'node:fs'
import pg from 'pg'
import { adapters } from '../adapters/registry.ts'
import type { AdapterContext, SourceSystem } from '../adapters/types.ts'
import { ingestTimestamp, loadConfig, TIME_ZONE } from '../config.ts'
import { writeIngest } from '../db/ingest.ts'
import { claimedBy, listSourcePaths, readSourceFiles } from '../ingest/files.ts'
import { formatSummary, runAdapters, summarize } from '../ingest/run.ts'

// ICS expansion window around "today" (ARCHITECTURE adapter contract defaults).
const HISTORY_DAYS = 731
const HORIZON_DAYS = 31

const config = loadConfig()
if (!existsSync(config.dataPackDir)) {
  console.error(`ingest: data pack not found at ${config.dataPackDir} (set DATA_PACK_DIR)`)
  process.exit(1)
}

const ctx: AdapterContext = {
  dataPackDir: config.dataPackDir,
  // Provenance timestamp of this run; "today" and "now" come from config, never the clock.
  ingestedAt: ingestTimestamp(),
  today: config.today,
  now: config.now,
  timeZone: TIME_ZONE,
  historyDays: HISTORY_DAYS,
  horizonDays: HORIZON_DAYS,
}

const paths = listSourcePaths(config.dataPackDir)
const claimed = new Map<SourceSystem, string[]>(
  adapters.map((adapter) => [adapter.sourceSystem, claimedBy(adapter, paths)]),
)
const claimedPaths = new Set([...claimed.values()].flat())
const unclaimed = paths.filter((filePath) => !claimedPaths.has(filePath))

const results = runAdapters(
  adapters,
  claimed,
  (files) => readSourceFiles(config.dataPackDir, files),
  ctx,
)
const summary = summarize(results, unclaimed)

const client = new pg.Client({ connectionString: config.databaseUrl })
await client.connect()
try {
  const runId = await writeIngest(client, ctx, results, summary)
  console.log(`ingest: run ${String(runId)} from ${config.dataPackDir}`)
  console.log(formatSummary(summary))
} finally {
  await client.end()
}
if (summary.totals.errors > 0) process.exitCode = 1
