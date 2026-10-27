import { existsSync } from 'node:fs'
import { loadConfig } from '../config.ts'
import { runPipeline } from '../ingest/pipeline.ts'
import { formatSummary } from '../ingest/run.ts'

// `npm run setup` (after `docker compose up`) and `npm run ingest`: the whole pipeline (R22).
const config = loadConfig()
if (!existsSync(config.dataPackDir)) {
  console.error(`setup: data pack not found at ${config.dataPackDir} (set DATA_PACK_DIR)`)
  process.exit(1)
}

const result = await runPipeline({
  dataPackDir: config.dataPackDir,
  databaseUrl: config.databaseUrl,
  today: config.today,
  now: config.now,
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
