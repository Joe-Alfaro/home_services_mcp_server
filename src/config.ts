import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DateTime } from 'luxon'
import { z } from 'zod'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** All source times without a zone are read in, and all answers are presented in, this zone. */
export const TIME_ZONE = 'America/Chicago'

const DEFAULT_DB_PORT = 5434
const DEFAULT_TODAY = '2026-11-02'
const DEFAULT_DATA_PACK_DIR = 'data'
const READER_ROLE = 'hsmcp_reader'
// Local-only, set by migrations/0005_mcp_views.sql (like the compose superuser's password).
const DEFAULT_READER_PASSWORD = 'hsmcp_reader'

function readerUrlFor(databaseUrl: string, password: string): string {
  const url = new URL(databaseUrl)
  url.username = READER_ROLE
  url.password = password
  return url.toString()
}

export interface Config {
  databaseUrl: string
  /** The MCP server's connection: same database, as the SELECT-only `hsmcp_reader` role (R16). */
  readerDatabaseUrl: string
  dataPackDir: string
  /** The service's notion of "today" (YYYY-MM-DD in TIME_ZONE). Never the system clock. */
  today: string
  /** The service's notion of "now" as a UTC ISO instant. Defaults to local midnight of `today`. */
  now: string
  timeZone: string
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  READER_DATABASE_URL: z.string().min(1).optional(),
  HSMCP_READER_PASSWORD: z.string().min(1).default(DEFAULT_READER_PASSWORD),
  HSMCP_DB_PORT: z
    .string()
    .regex(/^\d+$/, 'must be a port number')
    .transform(Number)
    .default(DEFAULT_DB_PORT),
  DATA_PACK_DIR: z.string().min(1).default(DEFAULT_DATA_PACK_DIR),
  HS_TODAY: z
    .string()
    .refine(
      (value) =>
        /^\d{4}-\d{2}-\d{2}$/.test(value) && DateTime.fromISO(value, { zone: TIME_ZONE }).isValid,
      'must be a calendar date in YYYY-MM-DD form',
    )
    .default(DEFAULT_TODAY),
  HS_NOW: z
    .string()
    .refine(
      (value) => DateTime.fromISO(value, { zone: TIME_ZONE }).isValid,
      'must be an ISO date-time',
    )
    .optional(),
})

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    throw new Error(`Invalid configuration: ${problems}`)
  }
  const values = parsed.data
  const now = DateTime.fromISO(values.HS_NOW ?? values.HS_TODAY, { zone: TIME_ZONE })
    .toUTC()
    .toISO()
  if (now === null) throw new Error('Invalid configuration: HS_NOW could not be resolved')
  const databaseUrl =
    values.DATABASE_URL ?? `postgres://hsmcp:hsmcp@localhost:${String(values.HSMCP_DB_PORT)}/hsmcp`
  return {
    databaseUrl,
    readerDatabaseUrl:
      values.READER_DATABASE_URL ?? readerUrlFor(databaseUrl, values.HSMCP_READER_PASSWORD),
    dataPackDir: path.resolve(REPO_ROOT, values.DATA_PACK_DIR),
    today: values.HS_TODAY,
    now,
    timeZone: TIME_ZONE,
  }
}

/**
 * The ingest run's provenance timestamp: a UTC instant without milliseconds. This is the only
 * place src/ reads the system clock; it is never used for "today" or "now" (R14).
 */
export function ingestTimestamp(clock: () => Date = () => new Date()): string {
  return clock()
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
}
