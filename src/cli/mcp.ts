import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import pg from 'pg'
import { loadConfig } from '../config.ts'
import { createServer } from '../mcp/server.ts'

// `npm start`: the MCP server on stdio, connected as the read-only role (R15, R16).
// stdout carries the MCP protocol; anything human-readable goes to stderr.
const config = loadConfig()
const pool = new pg.Pool({ connectionString: config.readerDatabaseUrl, max: 4 })
pool.on('error', (error) => {
  console.error(`mcp: database pool error: ${error.message}`)
})

try {
  await pool.query('SELECT 1 FROM v_providers LIMIT 1')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`mcp: cannot read the database as hsmcp_reader (${message}); run npm run setup`)
  await pool.end()
  process.exit(1)
}

const server = createServer({ pool, today: config.today, now: config.now })
await server.connect(new StdioServerTransport())
console.error(`mcp: home-services server listening on stdio (today ${config.today})`)

async function shutdown(): Promise<void> {
  await server.close()
  await pool.end()
}
process.stdin.on('close', () => {
  void shutdown()
})
process.on('SIGTERM', () => {
  void shutdown().then(() => process.exit(0))
})
