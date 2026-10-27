import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from '../../../src/mcp/server.ts'

/*
 * Polish-phase tool contract (R18 b, R18 c, R17, Q1) checked through an in-memory MCP client. No
 * database: the server gets a pool whose every query fails the way Postgres or the driver would,
 * so listTools and the error path can be tested without Docker.
 *
 * Pinned here:
 *   - Every date parameter (its description says YYYY-MM-DD) carries a JSON Schema `pattern` or
 *     `format` ("date" / "date-time") that accepts "2026-11-02" and rejects "tomorrow" and
 *     "11/02/2026" (R18 b).
 *   - An unexpected database failure reaches the client as an isError result that names the tool
 *     and says what to do, and never echoes the driver's message, SQL, relation or column names,
 *     SQLSTATE codes, hosts/ports or a stack trace (R18 c, R17).
 *   - get_provider_openings and get_provider_profile take `minMinutes`: an integer with a minimum
 *     and a maximum (at most 1440) and default 30. find_providers keeps minOpeningMinutes and
 *     rank_providers_for_job keeps jobMinutes, their existing min-length parameters (R18 b).
 *   - search_job_history_near_address (Q1 summary mode) takes `limit` (integer, default 10-50,
 *     maximum 100-200), `cursor` (string, from nextCursor) and an optional `trade` (the trade
 *     enum) that filters the paged job list; its description tells the agent to answer from the
 *     per-trade counts and to page only if it needs the individual jobs.
 */

const Q1_ADDRESS = '4512 Live Oak St, Dallas, TX 75204'

/** A valid call per tool; every one must reach the database. */
const VALID_CALLS: [string, Record<string, unknown>][] = [
  [
    'search_job_history_near_address',
    { address: Q1_ADDRESS, radiusMiles: 0.5, lastMonths: 24, groupBy: 'trade' },
  ],
  [
    'find_providers',
    { trade: 'handyman', workedInZip: '75214', minOpeningMinutes: 120, window: 'next_3_days' },
  ],
  [
    'get_scheduled_work_on_block',
    { street: 'Live Oak St', blockNumber: 4500, zip: '75204', nextDays: 14 },
  ],
  ['get_provider_profile', { providerName: 'Pecan Valley Plumbing', openingsLimit: 3 }],
  ['get_property_service_history', { address: '5823 Belmont Ave, Dallas, TX 75206' }],
  [
    'rank_providers_for_job',
    {
      trade: 'plumbing',
      service: 'water heater replacement',
      nearZip: '75206',
      window: 'this_week',
    },
  ],
  [
    'get_provider_openings',
    { providerId: 'prov_0123456789abcdef', from: '2026-11-02', to: '2026-11-05' },
  ],
]

interface DbFailure {
  name: string
  error: () => Error
  /** Strings from the failure that must never reach the client. */
  leaks: string[]
}

function pgError(message: string, fields: Record<string, string>): Error {
  return Object.assign(new Error(message), {
    severity: 'ERROR',
    ...fields,
  })
}

const FAILURES: DbFailure[] = [
  {
    name: 'missing relation',
    error: () =>
      pgError('relation "v_jobs" does not exist', {
        code: '42P01',
        position: '15',
        file: 'parse_relation.c',
        routine: 'parserOpenTable',
      }),
    leaks: ['relation', 'does not exist', 'v_jobs', '42P01', 'parse_relation', 'parserOpenTable'],
  },
  {
    name: 'permission denied',
    error: () =>
      pgError('permission denied for table homeowner_contacts', {
        code: '42501',
        table: 'homeowner_contacts',
      }),
    leaks: ['permission denied', 'homeowner_contacts', '42501'],
  },
  {
    name: 'bad column with SQL in the message',
    error: () =>
      pgError(
        'column j.lat_deg does not exist at character 212: SELECT j.id FROM v_jobs j WHERE j.lat_deg IS NOT NULL',
        { code: '42703', hint: 'Perhaps you meant to reference the column "j.lat".' },
      ),
    leaks: ['lat_deg', 'v_jobs', '42703', 'Perhaps you meant', 'character 212'],
  },
  {
    name: 'connection refused',
    error: () =>
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5434'), {
        code: 'ECONNREFUSED',
        address: '127.0.0.1',
        port: 5434,
      }),
    leaks: ['ECONNREFUSED', '127.0.0.1', '5434'],
  },
]

/** Generic shapes of internals that must not appear in any error text. */
const INTERNALS = [
  /\b(SELECT|FROM|WHERE|JOIN|INSERT|UPDATE)\b/,
  /\bv_[a-z_]+\b/,
  /\n\s*at\s/,
  /\.(ts|js):\d+/,
  /node_modules/,
  /postgres(ql)?:\/\//i,
]

/** A pool whose every query and checkout fails with `make()`. */
function failingPool(make: () => Error): pg.Pool {
  const fail = () => Promise.reject(make())
  return {
    query: fail,
    connect: fail,
    end: () => Promise.resolve(),
    on: () => undefined,
  } as unknown as pg.Pool
}

const open: { close: () => Promise<void> }[] = []

async function connect(pool: pg.Pool): Promise<Client> {
  const server = createServer({ pool, today: '2026-11-02', now: '2026-11-02T06:00:00Z' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'r18-unit', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  open.push(client, server)
  return client
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()))
})

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

type JsonSchema = Record<string, unknown>

async function toolSchemas(): Promise<Map<string, { description: string; props: JsonSchema }>> {
  const client = await connect(failingPool(() => new Error('unused')))
  const { tools } = await client.listTools()
  return new Map(
    tools.map((tool) => [
      tool.name,
      {
        description: tool.description ?? '',
        props: tool.inputSchema.properties ?? {},
      },
    ]),
  )
}

function prop(props: JsonSchema, name: string, what: string): JsonSchema {
  const value = props[name]
  if (typeof value !== 'object' || value === null) throw new Error(`${what} has no "${name}"`)
  return value as JsonSchema
}

describe('R18 b: date parameters carry a JSON Schema pattern or format', () => {
  it('pins the known date parameters', async () => {
    const schemas = await toolSchemas()
    const dated = [...schemas.entries()].flatMap(([tool, { props }]) =>
      Object.entries(props)
        .filter(([, schema]) => /YYYY-MM-DD/.test(String((schema as JsonSchema).description)))
        .map(([name]) => `${tool}.${name}`),
    )
    expect(dated).toEqual(
      expect.arrayContaining([
        'search_job_history_near_address.since',
        'search_job_history_near_address.until',
        'get_provider_openings.from',
        'get_provider_openings.to',
      ]),
    )
  })

  it('gives every date parameter a pattern or format that accepts YYYY-MM-DD only', async () => {
    const schemas = await toolSchemas()
    const checked = [...schemas.entries()].flatMap(([tool, { props }]) =>
      Object.entries(props)
        .filter(([, schema]) => /YYYY-MM-DD/.test(String((schema as JsonSchema).description)))
        .map(([name, schema]) => ({ field: `${tool}.${name}`, schema: schema as JsonSchema })),
    )
    expect(checked.length).toBeGreaterThan(0)
    checked.forEach(({ field, schema }) => {
      const { pattern, format } = schema
      if (typeof pattern === 'string') {
        const re = new RegExp(pattern)
        expect(re.test('2026-11-02'), `${field} pattern accepts 2026-11-02`).toBe(true)
        expect(re.test('tomorrow'), `${field} pattern rejects "tomorrow"`).toBe(false)
        expect(re.test('11/02/2026'), `${field} pattern rejects 11/02/2026`).toBe(false)
        return
      }
      expect(['date', 'date-time'], `${field} has a pattern or an ISO format`).toContain(format)
    })
  })
})

describe('R18 c, R17: an unexpected database error is generic, names the tool and leaks nothing', () => {
  describe.each(FAILURES)('$name', ({ error, leaks }) => {
    it.each(VALID_CALLS)('%s', async (tool, args) => {
      const client = await connect(failingPool(error))
      const result = await client.callTool({ name: tool, arguments: args })
      const raw = [textOf(result.content), JSON.stringify(result.structuredContent ?? null)].join(
        '\n',
      )
      expect(result.isError, raw).toBe(true)
      expect(raw, 'names the tool').toContain(tool)
      expect(raw, 'says what to do next').toMatch(/retry|try again/i)
      leaks.forEach((leak) => {
        expect(raw, `does not echo "${leak}"`).not.toContain(leak)
      })
      INTERNALS.forEach((pattern) => {
        expect(raw, `no internals matching ${String(pattern)}`).not.toMatch(pattern)
      })
    })
  })
})

describe('R18 b: openings tools take a bounded minMinutes, default 30', () => {
  it.each(['get_provider_openings', 'get_provider_profile'])('%s.minMinutes', async (tool) => {
    const schemas = await toolSchemas()
    const props = schemas.get(tool)?.props ?? {}
    const minMinutes = prop(props, 'minMinutes', tool)
    expect(minMinutes.type).toBe('integer')
    expect(typeof minMinutes.minimum).toBe('number')
    expect(minMinutes.minimum as number).toBeGreaterThanOrEqual(0)
    expect(typeof minMinutes.maximum).toBe('number')
    expect(minMinutes.maximum as number).toBeLessThanOrEqual(1440)
    expect(minMinutes.default).toBe(30)
    expect(String(minMinutes.description)).toMatch(/minutes/i)
    expect(schemas.get(tool)?.description ?? '').toContain('minMinutes')
  })
})

describe('Q1 summary mode: search_job_history_near_address paging parameters (R18 a-b)', () => {
  it('takes a bounded limit, an opaque cursor and an optional trade filter', async () => {
    const props = (await toolSchemas()).get('search_job_history_near_address')?.props ?? {}
    const limit = prop(props, 'limit', 'search_job_history_near_address')
    expect(limit.type).toBe('integer')
    expect(limit.minimum).toBe(1)
    expect(limit.maximum as number).toBeGreaterThanOrEqual(100)
    expect(limit.maximum as number).toBeLessThanOrEqual(200)
    expect(limit.default as number).toBeGreaterThanOrEqual(10)
    expect(limit.default as number).toBeLessThanOrEqual(50)

    const cursor = prop(props, 'cursor', 'search_job_history_near_address')
    expect(cursor.type).toBe('string')
    expect(String(cursor.description)).toMatch(/nextCursor/)

    const trade = prop(props, 'trade', 'search_job_history_near_address')
    expect(trade.enum).toEqual(expect.arrayContaining(['handyman', 'plumbing', 'hvac', 'pest']))
  })

  it('tells the agent to answer from the per-trade counts and page only if needed', async () => {
    const description =
      (await toolSchemas()).get('search_job_history_near_address')?.description ?? ''
    expect(description).toMatch(/per-trade counts|counts per trade/i)
    expect(description).toMatch(/sample/i)
    expect(description).toMatch(/nextCursor/)
    expect(description).toMatch(/\bcursor\b/)
    expect(description).toMatch(/\blimit\b/)
    expect(description).toMatch(/\bonly\b[^.]*\b(need|needed)\b/i)
  })
})
