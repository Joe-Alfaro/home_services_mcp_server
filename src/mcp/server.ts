import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ServerOptions } from './context.ts'
import {
  registerFindProviders,
  registerGetPropertyServiceHistory,
  registerGetProviderOpenings,
  registerGetProviderProfile,
  registerGetScheduledWorkOnBlock,
  registerRankProvidersForJob,
  registerSearchJobHistoryNearAddress,
} from './tools/index.ts'

export type { ServerOptions } from './context.ts'

/** States the server's today so the agent never substitutes its own date (R14, D-149). */
function instructions(today: string): string {
  return `Read-only data about home-service providers, homes and jobs in a few Dallas zips.
Today is ${today}: the server's fixed "today" (configured by HS_TODAY), whatever the date is where you run.
Every relative window is computed from that today: "last 24 months", "next 3 days", "next 14 days", "this week" (Monday-Sunday) and the next 30 days of openings. Use this date, not your own clock or the caller's date, when you read or explain an answer.
Each response repeats it as query.today, with the resolved window boundaries.
All times are America/Chicago with their offset.
Homes appear as "<hundred> block of <street>" plus zip; homeowner names, phones and emails are never returned.
Every item cites its sources (sourceSystem, sourceFile, sourceRecordId).`
}

/**
 * The MCP server with the seven tools of ARCHITECTURE.md (R15). It answers only from `pool`,
 * which should be logged in as the SELECT-only hsmcp_reader role (R16); `today` and `now` drive
 * every relative window (R14).
 */
export function createServer(options: ServerOptions): McpServer {
  const server = new McpServer(
    { name: 'home-services', version: '0.1.0' },
    { instructions: instructions(options.today) },
  )
  registerSearchJobHistoryNearAddress(server, options)
  registerFindProviders(server, options)
  registerGetScheduledWorkOnBlock(server, options)
  registerGetProviderProfile(server, options)
  registerGetPropertyServiceHistory(server, options)
  registerRankProvidersForJob(server, options)
  registerGetProviderOpenings(server, options)
  return server
}
