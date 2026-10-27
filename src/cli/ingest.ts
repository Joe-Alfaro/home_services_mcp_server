import { existsSync } from 'node:fs'
import { loadConfig } from '../config.ts'

// Stub: the source adapters and the ingest pipeline that calls them land in M0's adapter work.
const config = loadConfig()
if (!existsSync(config.dataPackDir)) {
  console.error(`ingest: data pack not found at ${config.dataPackDir} (set DATA_PACK_DIR)`)
  process.exit(1)
}
console.log(`ingest: data pack at ${config.dataPackDir}; no adapters registered yet`)
