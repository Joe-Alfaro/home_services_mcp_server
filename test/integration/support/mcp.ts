import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import pg from 'pg'
import {
  loadPipeline,
  loadServer,
  NOW,
  readerUrl,
  runPackPipeline,
  startPostgres,
  TODAY,
} from './pack.ts'

/** The seven tools of ARCHITECTURE.md "MCP tools" (R15 a). */
export const TOOL_NAMES = [
  'find_providers',
  'get_property_service_history',
  'get_provider_openings',
  'get_provider_profile',
  'get_scheduled_work_on_block',
  'rank_providers_for_job',
  'search_job_history_near_address',
] as const

export interface ToolCall {
  /** Every text the client received for the call, joined; for the PII scan. */
  raw: string
  isError: boolean
  /** Parsed JSON body of a successful call; undefined for an error. */
  body: unknown
}

export interface McpHarness {
  client: Client
  admin: pg.Client
  reader: pg.Pool
  call(name: string, args: Record<string, unknown>): Promise<ToolCall>
  close(): Promise<void>
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((item: unknown) =>
      typeof item === 'object' && item !== null && 'text' in item && typeof item.text === 'string'
        ? item.text
        : '',
    )
    .join('\n')
}

/**
 * Ingests the fixture pack into a throwaway Postgres, then connects an in-memory MCP client to
 * the server built on a pool logged in as the read-only role (R16).
 */
export async function startMcpHarness(): Promise<McpHarness> {
  const container: StartedPostgreSqlContainer = await startPostgres()
  const adminUrl = container.getConnectionUri()
  try {
    await runPackPipeline(await loadPipeline(), adminUrl)
  } catch (error) {
    await container.stop()
    throw error
  }
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  const reader = new pg.Pool({ connectionString: await readerUrl(admin, adminUrl), max: 4 })

  const serverModule = await loadServer()
  const server = serverModule.createServer({ pool: reader, today: TODAY, now: NOW })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'integration-test', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)

  async function call(name: string, args: Record<string, unknown>): Promise<ToolCall> {
    try {
      const result = await client.callTool({ name, arguments: args })
      const raw = [textOf(result.content), JSON.stringify(result.structuredContent ?? null)].join(
        '\n',
      )
      if (result.isError === true) return { raw, isError: true, body: undefined }
      return { raw, isError: false, body: JSON.parse(textOf(result.content)) as unknown }
    } catch (error) {
      // Some SDK versions reject invalid arguments instead of returning an error result.
      const raw = error instanceof Error ? error.message : String(error)
      return { raw, isError: true, body: undefined }
    }
  }

  async function close(): Promise<void> {
    await client.close()
    await server.close()
    await reader.end()
    await admin.end()
    await container.stop()
  }

  return { client, admin, reader, call, close }
}

// --- Small readers for untyped JSON bodies -------------------------------------------------

export type Json = Record<string, unknown>

export function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function obj(value: unknown, what: string): Json {
  if (!isObject(value)) throw new Error(`${what} is not an object: ${JSON.stringify(value)}`)
  return value
}

export function arr(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not an array: ${JSON.stringify(value)}`)
  return value
}

export function str(value: unknown, what: string): string {
  if (typeof value !== 'string')
    throw new Error(`${what} is not a string: ${JSON.stringify(value)}`)
  return value
}

export function num(value: unknown, what: string): number {
  if (typeof value !== 'number')
    throw new Error(`${what} is not a number: ${JSON.stringify(value)}`)
  return value
}

/** Every value under `key` anywhere in a JSON tree, with the path it was found at. */
export function collect(tree: unknown, key: string, at = '$'): { path: string; value: unknown }[] {
  if (Array.isArray(tree))
    return tree.flatMap((item, index) => collect(item, key, `${at}[${String(index)}]`))
  if (!isObject(tree)) return []
  return Object.entries(tree).flatMap(([name, value]) => [
    ...(name === key ? [{ path: `${at}.${name}`, value }] : []),
    ...collect(value, key, `${at}.${name}`),
  ])
}

/** Every string in a JSON tree that looks like an ISO date-time, except inside source citations. */
export function dateTimes(tree: unknown, at = '$'): { path: string; value: string }[] {
  if (typeof tree === 'string') {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(tree) ? [{ path: at, value: tree }] : []
  }
  if (Array.isArray(tree)) {
    return tree.flatMap((item, index) => dateTimes(item, `${at}[${String(index)}]`))
  }
  if (!isObject(tree)) return []
  return Object.entries(tree)
    .filter(([name]) => name !== 'sources' && name !== 'sourceRecordId')
    .flatMap(([name, value]) => dateTimes(value, `${at}.${name}`))
}
