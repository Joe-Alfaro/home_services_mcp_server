import { existsSync } from 'node:fs'
import path from 'node:path'
import { ingestTimestamp, loadConfig } from '../config.ts'
import { runPipeline } from '../ingest/pipeline.ts'
import { formatSummary } from '../ingest/run.ts'

// `npm run ingest` (and `npm run setup` after `docker compose up`): the whole pipeline (R22).
const config = loadConfig()
// data/ itself is tracked (empty), so look for the pack's sources/ folder, not just the directory.
if (!existsSync(path.join(config.dataPackDir, 'sources'))) {
  console.error(
    `ingest: data pack not found at ${config.dataPackDir}: copy the pack into data/ (see data/README.md) or set DATA_PACK_DIR`,
  )
  process.exit(1)
}

const result = await runPipeline({
  dataPackDir: config.dataPackDir,
  databaseUrl: config.databaseUrl,
  today: config.today,
  now: config.now,
  // Provenance timestamp of this run; "today" and "now" come from config, never the clock (R14).
  ingestedAt: ingestTimestamp(),
})

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([key, count]) => `${key} ${String(count)}`)
    .join(', ')
}

console.log(`ingest: run ${String(result.runId)} from ${config.dataPackDir}`)
console.log(formatSummary(result.summary))
console.log(`canonical: ${formatCounts(result.canonical)}`)
Object.entries(result.linksByMethod).forEach(([table, counts]) => {
  console.log(`  ${table} by method: ${formatCounts(counts)}`)
})
if (result.summary.totals.errors > 0) process.exitCode = 1
