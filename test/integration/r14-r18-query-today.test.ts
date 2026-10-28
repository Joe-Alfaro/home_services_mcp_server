import { DateTime } from 'luxon'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.ts'
import {
  connectServer,
  obj,
  startMcpHarness,
  str,
  TOOL_NAMES,
  type Json,
  type McpHarness,
  type ServerConnection,
} from './support/mcp.ts'

/*
 * R14 + R18: every tool response tells the agent which "today" the server answered for, and the
 * window it resolved from it, so the agent never substitutes its own system date (D-149). Run on
 * the ingested fixture pack (test/fixtures/pack) for the default today (2026-11-02) and for
 * HS_TODAY=2026-11-09 (clock from loadConfig, same database).
 *
 * Pinned response fields (extra fields are fine):
 *   query.today  = the server's today, "YYYY-MM-DD", on every one of the seven tools.
 *   window       = { from, to }: local-midnight date-times with their America/Chicago offset, `to`
 *                  exclusive. At `query.window`, or the existing top-level `window` echo
 *                  (get_scheduled_work_on_block, get_provider_openings), wherever a window
 *                  applies:
 *     search_job_history_near_address lastMonths 24   [today - 24 months, today)
 *     find_providers                  next_3_days     [today, today + 3 days)
 *     get_scheduled_work_on_block     nextDays 14     [today, today + 14 days)
 *     get_provider_profile            next openings   [today, today + 30 days)
 *     rank_providers_for_job          this_week       [Monday, next Monday) containing today
 *     get_provider_openings           from/to given   [from, to) as passed
 *   get_property_service_history has no window; only query.today.
 *
 * 2026-11-02 and 2026-11-09 are Mondays, after DST ended (-06:00); 2024-11-02 was still CDT
 * (-05:00), 2024-11-09 CST (-06:00).
 */

const Q1_ADDRESS = '4512 Live Oak St, Dallas, TX 75204'
const Q5_ADDRESS = '5823 Belmont Ave, Dallas, TX 75206'

interface Case {
  today: string
  /** Expected { from, to } per tool; absent = no window applies. */
  windows: Partial<Record<(typeof TOOL_NAMES)[number], { from: string; to: string }>>
}

function midnight(date: string, offset = '-06:00'): string {
  return `${date}T00:00:00${offset}`
}

const CASES: Case[] = [
  {
    today: '2026-11-02',
    windows: {
      search_job_history_near_address: {
        from: midnight('2024-11-02', '-05:00'),
        to: midnight('2026-11-02'),
      },
      find_providers: { from: midnight('2026-11-02'), to: midnight('2026-11-05') },
      get_scheduled_work_on_block: { from: midnight('2026-11-02'), to: midnight('2026-11-16') },
      get_provider_profile: { from: midnight('2026-11-02'), to: midnight('2026-12-02') },
      rank_providers_for_job: { from: midnight('2026-11-02'), to: midnight('2026-11-09') },
      get_provider_openings: { from: midnight('2026-11-03'), to: midnight('2026-11-06') },
    },
  },
  {
    today: '2026-11-09',
    windows: {
      search_job_history_near_address: { from: midnight('2024-11-09'), to: midnight('2026-11-09') },
      find_providers: { from: midnight('2026-11-09'), to: midnight('2026-11-12') },
      get_scheduled_work_on_block: { from: midnight('2026-11-09'), to: midnight('2026-11-23') },
      get_provider_profile: { from: midnight('2026-11-09'), to: midnight('2026-12-09') },
      rank_providers_for_job: { from: midnight('2026-11-09'), to: midnight('2026-11-16') },
      get_provider_openings: { from: midnight('2026-11-10'), to: midnight('2026-11-13') },
    },
  },
]

/** One benchmark-style call per tool; get_provider_openings starts the day after today. */
function callsFor(today: string, providerId: string): [string, Record<string, unknown>][] {
  const plus = (days: number) => DateTime.fromISO(today).plus({ days }).toISODate()
  return [
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
    ['get_provider_profile', { providerId, openingsLimit: 3 }],
    ['get_property_service_history', { address: Q5_ADDRESS }],
    [
      'rank_providers_for_job',
      {
        trade: 'plumbing',
        service: 'water heater replacement',
        nearZip: '75206',
        window: 'this_week',
      },
    ],
    ['get_provider_openings', { providerId, from: plus(1), to: plus(4) }],
  ]
}

describe('R14/R18: every tool echoes the server today and its resolved window', () => {
  let harness: McpHarness | undefined
  const connections = new Map<string, ServerConnection>()
  let providerId = ''

  beforeAll(async () => {
    harness = await startMcpHarness()
    const profile = await harness.call('get_provider_profile', {
      providerName: 'Pecan Valley Plumbing',
      openingsLimit: 1,
    })
    expect(profile.isError, profile.raw).toBe(false)
    providerId = str(obj(profile.body, 'profile').providerId, 'providerId')
    await Promise.all(
      CASES.map(async ({ today }) => {
        const config = loadConfig({ HS_TODAY: today })
        if (harness === undefined) throw new Error('MCP harness did not start')
        connections.set(
          today,
          await connectServer(harness.reader, { today: config.today, now: config.now }),
        )
      }),
    )
  })

  afterAll(async () => {
    await Promise.all([...connections.values()].map((connection) => connection.close()))
    await harness?.close()
  })

  async function body(today: string, name: string, args: Record<string, unknown>): Promise<Json> {
    const connection = connections.get(today)
    if (connection === undefined) throw new Error(`no server for ${today}`)
    const result = await connection.call(name, args)
    expect(result.isError, `${name} failed: ${result.raw}`).toBe(false)
    return obj(result.body, `${name} body`)
  }

  it('R14/R18: the calls cover all seven tools', () => {
    expect(callsFor('2026-11-02', 'prov_x').map(([name]) => name)).toEqual(
      expect.arrayContaining([...TOOL_NAMES]),
    )
  })

  describe.each(CASES)('HS_TODAY=$today', ({ today, windows }) => {
    it.each(TOOL_NAMES.map((name) => [name]))(
      'R14/R18: %s puts query.today = the server today',
      async (name) => {
        const call = callsFor(today, providerId).find(([candidate]) => candidate === name)
        if (call === undefined) throw new Error(`no call for ${name}`)
        const answer = await body(today, ...call)

        expect(answer.query, `${name} has a query block`).toBeTypeOf('object')
        expect(obj(answer.query, `${name}.query`).today).toBe(today)
      },
    )

    it.each(Object.entries(windows))(
      'R14/R18: %s echoes the resolved window with offsets',
      async (name, expected) => {
        const call = callsFor(today, providerId).find(([candidate]) => candidate === name)
        if (call === undefined) throw new Error(`no call for ${name}`)
        const answer = await body(today, ...call)
        const query = answer.query
        const echoed =
          typeof query === 'object' && query !== null && 'window' in query
            ? query.window
            : answer.window
        const window = obj(echoed, `${name} window (query.window or window)`)

        expect({ from: window.from, to: window.to }).toEqual(expected)
      },
    )
  })
})
