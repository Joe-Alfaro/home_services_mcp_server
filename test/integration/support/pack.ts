import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import pg from 'pg'

/*
 * Entry points pinned by the M1b pipeline and M2 MCP integration tests (red until they exist).
 *
 * src/ingest/pipeline.ts
 *   export function runPipeline(options: PipelineOptions): Promise<PipelineResult>
 *   - Runs the whole ingest against `databaseUrl`: applies migrations, loads
 *     `<dataPackDir>/reference/street_segments.csv`, runs every registered adapter over
 *     `<dataPackDir>/sources/`, normalizes, resolves and loads the canonical tables of
 *     ARCHITECTURE.md in one transaction that replaces the previous run (R22 b), and leaves the
 *     read views and the `hsmcp_reader` role with SELECT on the views only (R16, R17).
 *   - Uses `today` and `now` from the options, never the clock (R14). Does not start Docker.
 *   - `summary.totals` counts records, error issues and unmapped statuses for the run (R1, R9).
 *
 * src/mcp/server.ts
 *   export function createServer(options: ServerOptions): McpServer
 *   - Registers the seven tools of ARCHITECTURE.md on a new McpServer and answers from `pool`
 *     (the tests connect it as `hsmcp_reader`). `today`/`now` drive every relative window.
 *   - Each tool returns its JSON body as the text of its first content item (structuredContent
 *     is optional). Invalid input and tool errors come back as `isError: true` results (or a
 *     rejected call) whose text names the bad field and the accepted values (R18 c).
 *
 * The tests load both modules by absolute path at run time, so this branch type-checks and
 * lints while they are missing; the run fails with "Cannot find module" or "not a function".
 */

export interface PipelineOptions {
  dataPackDir: string
  databaseUrl: string
  /** "YYYY-MM-DD" in America/Chicago. */
  today: string
  /** UTC instant, e.g. "2026-11-02T06:00:00Z". */
  now: string
}

export interface PipelineResult {
  runId: number
  summary: { totals: { records: number; errors: number; unmappedStatuses: number } }
}

export interface PipelineModule {
  runPipeline(options: PipelineOptions): Promise<PipelineResult>
}

export interface ServerOptions {
  pool: pg.Pool
  today: string
  now: string
}

export interface ServerModule {
  createServer(options: ServerOptions): McpServer
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

export const PACK_DIR = path.join(REPO_ROOT, 'test/fixtures/pack')
/** A second, independent invented pack for facts the main pack's hand-computed answers avoid. */
export const FACTS_PACK_DIR = path.join(REPO_ROOT, 'test/fixtures/facts_pack')
/** A third invented pack with enough nearby work (182 jobs, 7 trades) to page Q1's job list. */
export const Q1_PACK_DIR = path.join(REPO_ROOT, 'test/fixtures/q1_pack')
export const TODAY = '2026-11-02'
export const NOW = '2026-11-02T06:00:00Z'
export const READER_ROLE = 'hsmcp_reader'

export const SOURCE_SYSTEMS = [
  'housecall_pro',
  'ics',
  'jobber',
  'profiles',
  'spreadsheet',
  'workiz',
] as const

export async function loadPipeline(): Promise<PipelineModule> {
  return (await import(path.join(REPO_ROOT, 'src/ingest/pipeline.ts'))) as PipelineModule
}

export async function loadServer(): Promise<ServerModule> {
  return (await import(path.join(REPO_ROOT, 'src/mcp/server.ts'))) as ServerModule
}

export function startPostgres(): Promise<StartedPostgreSqlContainer> {
  // A throwaway container per test file: integration tests never touch the dev DB (R23 b).
  return new PostgreSqlContainer('postgres:16-alpine').start()
}

export function runPackPipeline(
  pipeline: PipelineModule,
  databaseUrl: string,
  dataPackDir = PACK_DIR,
): Promise<PipelineResult> {
  return pipeline.runPipeline({ dataPackDir, databaseUrl, today: TODAY, now: NOW })
}

/**
 * Lets the test log in as the reader role the pipeline created. Only the password and LOGIN are
 * changed; grants stay exactly as the pipeline left them.
 */
export async function readerUrl(admin: pg.Client, adminUrl: string): Promise<string> {
  const password = 'reader-test-only'
  await admin.query(`ALTER ROLE ${READER_ROLE} WITH LOGIN PASSWORD '${password}'`)
  const url = new URL(adminUrl)
  url.username = READER_ROLE
  url.password = password
  return url.toString()
}

/** Raw text of a fixture file, by its path relative to the pack (as cited in `sourceFile`). */
export function readPackFile(sourceFile: string, packDir = PACK_DIR): string {
  return readFileSync(path.join(packDir, ...sourceFile.split('/')), 'utf8')
}

export interface Source {
  sourceSystem: string
  sourceFile: string
  sourceRecordId: string
}

/**
 * Whether a cited record exists in the cited fixture file (R19 b). Record ID conventions follow
 * the adapter contract: CSV "row:N" is a physical line, ICS "<UID>@<start>" an occurrence of UID,
 * and "<id>#address" a property derived from record <id>.
 */
export function citationExists(source: Source, packDir = PACK_DIR): boolean {
  const text = readPackFile(source.sourceFile, packDir)
  const id = source.sourceRecordId.replace(/#address$/, '')
  // Account-level records (e.g. a calendar or a log file) may use the file stem as their ID.
  if (source.sourceFile.includes(id)) return true
  const row = /^row:(\d+)$/.exec(id)
  if (row?.[1] !== undefined) return text.split('\n').length >= Number(row[1])
  if (source.sourceSystem === 'ics') return text.includes(`UID:${id.replace(/@[^@]*$/, '')}`)
  return text.includes(id)
}

/*
 * Homeowner PII planted in the fixture pack (R17, G27). None of it may appear in any tool
 * response, error or read view. The calendar owner's name comes from X-WR-CALNAME, which G27
 * says never reaches a tool response.
 */
export const HOMEOWNER_NAMES = [
  'Corrigan Hale',
  'Marisela Dunworth',
  'Tobias Fenwright',
  'Philippa Ostrowski',
  'Daria Wexley',
  'Anselm Pryce',
  'Beatrix Quennell',
  'Osric Lamberton',
  'Jessamy Tolliver',
  'Rupert Ashgrove',
  'Imelda Corcoran',
  'Fennimore Strand',
  'Sabine Ollerenshaw',
  'Gideon Marchbanks',
  'Thaddeus Wren',
  'Ottoline Varga',
  'Cosmo Haddad',
  'Linnea Brask',
  'Mabel Ruskin',
  'Ines Thackeray',
  'Wendell Okonjo',
]

/** Surnames distinctive enough to scan for on their own (e.g. "Job - Okonjo (...)"). */
export const HOMEOWNER_SURNAMES = HOMEOWNER_NAMES.map((name) => name.split(' ').at(-1) ?? name)

export const CALENDAR_OWNER_NAME = 'Rosalind Pratt'

export const HOMEOWNER_EMAILS = [
  'corrigan.hale@example.org',
  'tobias.f@example.net',
  'daria.w@example.com',
  'beatrix.q@example.org',
  'rupert.a@example.net',
  'fennimore.s@example.com',
  'gideon.m@example.net',
  'ottoline.v@example.com',
  'linnea.b@example.net',
]

/** Homeowner phone digits; matched in any format (dashes, dots, spaces, parentheses, +1). */
export const HOMEOWNER_PHONES = [
  '4695550181',
  '2145550182',
  '9725550183',
  '2145550184',
  '4695550185',
  '9725550186',
  '2145550187',
  '4695550188',
  '9725550189',
  '2145550190',
  '4695550191',
  '9725550192',
  '2145550193',
  '4695550194',
  '9725550195',
  '2145550196',
  '4695550197',
  '9725550198',
  '2145550161',
  '9725550162',
  '4695550163',
]

function phonePattern(digits: string): RegExp {
  const parts = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)]
  return new RegExp(`(?<!\\d)${parts.join('[^0-9]{0,3}')}(?!\\d)`)
}

/** Every planted PII value found in `text`, for a readable failure message. */
export function findPii(text: string, { includeCalendarOwner = true } = {}): string[] {
  const lower = text.toLowerCase()
  const names = [...HOMEOWNER_NAMES, ...(includeCalendarOwner ? [CALENDAR_OWNER_NAME] : [])]
  return [
    ...names.filter((name) => lower.includes(name.toLowerCase())),
    ...HOMEOWNER_SURNAMES.filter((surname) => new RegExp(`\\b${surname}\\b`, 'i').test(text)).map(
      (surname) => `surname ${surname}`,
    ),
    ...HOMEOWNER_EMAILS.filter((email) => lower.includes(email)),
    ...HOMEOWNER_PHONES.filter((digits) => phonePattern(digits).test(text)).map(
      (digits) => `phone ${digits}`,
    ),
  ]
}
