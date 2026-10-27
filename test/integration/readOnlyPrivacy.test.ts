import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findPii, type Source } from './support/pack.ts'
import {
  arr,
  collect,
  isObject,
  startMcpHarness,
  TOOL_NAMES,
  type McpHarness,
} from './support/mcp.ts'

/*
 * R16 and R17 on the fixture pack: the server's database role is read-only and cannot see
 * homeowner contacts, and no tool response or error carries a planted homeowner name, phone or
 * email (or the calendar owner's name from X-WR-CALNAME, G27). Harness and pinned entry points:
 * ./support/mcp.ts and ./support/pack.ts.
 *
 * Planted PII lives in CRM customer records, CRM job notes (CRM A instructions, CRM B notes,
 * CRM C JobNotes), the CSV Customer/Phone columns and an ICS SUMMARY ("Job - <surname> (...)").
 */

const SRC_MCP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/mcp')

const READ_VIEWS = [
  'v_providers',
  'v_properties',
  'v_jobs',
  'v_calendar_blocks',
  'v_declared_hours',
  'v_sources',
]

/** Fixture addresses whose house numbers a caller may supply (and so see echoed). */
const FIXTURE_ADDRESSES = [
  '5823 Belmont Ave, Dallas, TX 75206',
  '5823 Belmont Ave Apt B, Dallas, TX 75206',
  '4518 Live Oak St Apt 2, Dallas, TX 75204',
  '4533 Live Oak St Apt 4, Dallas, TX 75204',
  '4541 Live Oak St, Dallas, TX 75204',
  '4588 Live Oak St, Dallas, TX 75204',
  '4612 Live Oak St, Dallas, TX 75204',
  '4790 Live Oak St, Dallas, TX 75204',
  '4925 Live Oak St, Dallas, TX 75204',
  '3450 Cole Ave, Dallas, TX 75204',
  '150 Elm St, Dallas, TX 75204',
  '210 Elm St, Dallas, TX 75204',
  '1207 Tupelo Ave, Dallas, TX 75214',
  '1250 Tupelo Ave, Dallas, TX 75214',
  '1311 Tupelo Ave, Dallas, TX 75214',
  '1402 Tupelo Ave, Dallas, TX 75214',
  '1520 Tupelo Ave, Dallas, TX 75214',
  '1640 Tupelo Ave, Dallas, TX 75214',
  '5823 Juniper Ave, Dallas, TX 75206',
  '915 Glade Dr, Garland, TX 75041',
]

const BUSINESS_NAMES = [
  'Pecan Valley Plumbing',
  'Pecan Valley Pest Control',
  'Lakeside Handyman',
  'Bluestem Fix-It',
  'Mockingbird Drain & Plumbing',
  'Sumac Creek Rooter',
  'Bishop Arts Handyman',
  'Larkspur Handyman',
]

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? listFiles(full) : [full]
  })
}

describe('read-only role and homeowner privacy (R16, R17)', () => {
  let harness: McpHarness | undefined

  function mcp(): McpHarness {
    if (harness === undefined) throw new Error('MCP harness did not start')
    return harness
  }

  beforeAll(async () => {
    harness = await startMcpHarness()
  })

  afterAll(async () => {
    await harness?.close()
  })

  describe('database role (R16 a, R17 a)', () => {
    it('can read the views', async () => {
      const { rows } = await mcp().reader.query<{ n: string }>(
        'SELECT count(*) AS n FROM v_providers',
      )
      expect(Number(rows[0]?.n)).toBe(7)
    })

    it.each([
      ['providers', `INSERT INTO providers (display_name) VALUES ('x')`],
      ['jobs', `UPDATE jobs SET status = 'cancelled'`],
      ['properties', 'DELETE FROM properties'],
      [
        'source_records',
        `INSERT INTO source_records (run_id, source_system, source_account, source_file,
           source_record_id, record_type, ingested_at, payload)
         VALUES (1, 'x', 'x', 'x', 'x', 'x', now(), '{}')`,
      ],
    ])('cannot write to %s', async (_table, sql) => {
      await expect(mcp().reader.query(sql)).rejects.toThrow(/permission denied/i)
    })

    it.each(['homeowner_contacts', 'source_records'])(
      'cannot read %s, which holds homeowner contacts',
      async (table) => {
        await expect(mcp().reader.query(`SELECT * FROM ${table} LIMIT 1`)).rejects.toThrow(
          /permission denied/i,
        )
      },
    )

    it('sees no homeowner name, phone or email in any read view (R17)', async () => {
      const dumps = await Promise.all(
        READ_VIEWS.map(async (view) => {
          const { rows } = await mcp().reader.query(`SELECT * FROM ${view}`)
          return [view, findPii(JSON.stringify(rows), { includeCalendarOwner: false })] as const
        }),
      )
      expect(Object.fromEntries(dumps)).toEqual(
        Object.fromEntries(READ_VIEWS.map((view) => [view, []])),
      )
    })
  })

  describe('tool handlers (R16 b)', () => {
    it('never write SQL or files', () => {
      const offenders = listFiles(SRC_MCP)
        .filter((file) => file.endsWith('.ts'))
        .filter((file) =>
          /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|writeFile|appendFile|createWriteStream)\b/i.test(
            readFileSync(file, 'utf8'),
          ),
        )
      expect(offenders).toEqual([])
    })
  })

  describe('tool responses (R17 b, G27)', () => {
    let scanned: { label: string; raw: string; body: unknown }[] = []

    beforeAll(async () => {
      const listed = await mcp().client.listTools()
      const record = (label: string, raw: string, body?: unknown) => {
        scanned = [...scanned, { label, raw, body }]
      }
      record('listTools', JSON.stringify(listed))

      const window = { from: '2026-11-02', to: '2026-11-16' }
      const calls: [string, Record<string, unknown>][] = [
        ...FIXTURE_ADDRESSES.flatMap((address): [string, Record<string, unknown>][] => [
          ['get_property_service_history', { address }],
          [
            'search_job_history_near_address',
            { address, radiusMiles: 5, lastMonths: 24, groupBy: 'trade' },
          ],
        ]),
        ...BUSINESS_NAMES.map((providerName): [string, Record<string, unknown>] => [
          'get_provider_profile',
          { providerName, openingsLimit: 10 },
        ]),
        ...['Live Oak St', 'Belmont Ave', 'Tupelo Ave', 'Elm St'].flatMap(
          (street): [string, Record<string, unknown>][] =>
            [4500, 5800, 1200, 1300, 1400, 1500, 1600, 100, 200].map((blockNumber) => [
              'get_scheduled_work_on_block',
              { street, blockNumber, nextDays: 30 },
            ]),
        ),
        ...['handyman', 'plumbing', 'pest'].flatMap((trade): [string, Record<string, unknown>][] =>
          ['75204', '75206', '75214'].map((zip) => [
            'find_providers',
            { trade, workedInZip: zip, minOpeningMinutes: 30, window: 'next_3_days' },
          ]),
        ),
        ...['75204', '75206', '75214'].map((nearZip): [string, Record<string, unknown>] => [
          'rank_providers_for_job',
          { trade: 'plumbing', service: 'water heater replacement', nearZip, window: 'this_week' },
        ]),
        // Invalid input: errors must not echo stored data either.
        ['get_property_service_history', { address: '' }],
        ['get_provider_profile', { providerName: 'No Such Business', openingsLimit: 3 }],
        ['find_providers', { trade: 'carpentry' }],
        ['get_provider_openings', { providerId: 'not-a-provider', from: 'x', to: 'y' }],
      ]
      const results = await Promise.all(calls.map(([name, args]) => mcp().call(name, args)))
      results.forEach((result, index) => {
        record(
          `${calls[index]?.[0] ?? '?'} ${JSON.stringify(calls[index]?.[1])}`,
          result.raw,
          result.body,
        )
      })

      // Openings for every provider the tools surfaced.
      const providerIds = new Set(
        results
          .flatMap((result) => collect(result.body, 'providerId'))
          .map(({ value }) => value)
          .filter((value) => typeof value === 'string' || typeof value === 'number')
          .map(String),
      )
      const openings = await Promise.all(
        [...providerIds].map((providerId) =>
          mcp().call('get_provider_openings', { providerId, ...window, minMinutes: 0, limit: 50 }),
        ),
      )
      openings.forEach((result) => {
        record('get_provider_openings', result.raw, result.body)
      })
    })

    it('called every tool with data that holds planted PII', () => {
      TOOL_NAMES.forEach((name) => {
        expect(scanned.some(({ label }) => label.startsWith(name))).toBe(true)
      })
      const answered = scanned.filter(({ body }) => collect(body, 'sources').length > 0)
      expect(answered.length).toBeGreaterThan(20)
    })

    it('returns no homeowner name, phone or email anywhere, including errors', () => {
      const leaks = scanned
        .map(({ label, raw }) => ({ label, found: findPii(raw) }))
        .filter(({ found }) => found.length > 0)
      expect(leaks).toEqual([])
    })

    it('cites only sources with a system, file and record ID (R19 a)', () => {
      const citations = scanned
        .flatMap(({ body }) => collect(body, 'sources'))
        .flatMap(({ value }) => arr(value, 'sources'))
      expect(citations.length).toBeGreaterThan(0)
      citations.forEach((citation) => {
        expect(isObject(citation)).toBe(true)
        const source = citation as Source
        expect(typeof source.sourceSystem).toBe('string')
        expect(typeof source.sourceFile).toBe('string')
        expect(typeof source.sourceRecordId).toBe('string')
      })
    })
  })
})
