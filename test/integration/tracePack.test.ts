import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  arr,
  collect,
  obj,
  startMcpHarness,
  str,
  type Json,
  type McpHarness,
} from './support/mcp.ts'
import { PACK_DIR, TRACE_PACK_DIR, type Source } from './support/pack.ts'

/*
 * R19 traceability of calendar citations and G18 CSV-only bookings, end to end.
 *
 * R19: every (sourceSystem, sourceFile, sourceRecordId) a tool cites must equal a row of
 * source_records exactly. An ICS occurrence is stored as "<UID>@<occurrence start>"; the cited ID
 * must be that stored string, byte for byte, even though every other date-time in a response is
 * shown with a local offset (R12 e). Checked per tool on the trace pack below, then generically
 * for every tool response on the trace pack and the main fixture pack (test/fixtures/pack).
 *
 * The trace pack (test/fixtures/trace_pack): Hollis Creek Handyman (handyman; profile Mon-Fri
 * 8am-5pm, crew 1, zip 75214) with a CSV job log and an ICS calendar owned by the profile owner:
 *   CSV row:4  Mon 11-02 13:00 "1430 Tupelo Ave" shelf install     (no calendar event: CSV only)
 *   CSV row:5  Wed 11-04 09:00 "1410 Tupelo Ave" drywall patch     (mirrored by job-drywall-2)
 *   CSV row:6  Thu 11-05 09:00 "1420 Tupelo Ave" door repair       (mirrored by job-door-3)
 *   ICS weekly-lunch-1   every Tue 12:00-13:00 local from 10-06 (RRULE; occurrences span DST)
 *   ICS job-drywall-2    Wed 11-04 09:00-11:00, 1410 Tupelo Ave, STATUS:CONFIRMED
 *   ICS job-door-3       Thu 11-05 09:00-11:00, 1420 Tupelo Ave, STATUS:TENTATIVE
 *
 * G18 pinned behaviour (get_provider_openings and find_providers):
 *   - A CSV-only future booking blocks its slot at low confidence. Every opening that local day is
 *     `low`, cites the row, and has a reason naming the booking as recorded only in the job log:
 *     one reason matches both CSV_SOURCE and CSV_ONLY below. A "no end time" reason alone is not
 *     enough: it explains the length of the block, not why the booking is uncertain.
 *   - A CSV row mirrored by a calendar event is confirmed by that calendar, so it blocks at the
 *     calendar event's confidence: a CONFIRMED event → that day's openings stay `high`; a
 *     TENTATIVE event → `low` with the G17 tentative-hold reason. A mirrored CSV booking is never
 *     `medium` on its own account (the old "mirrored CSV = medium" branch cannot be reached,
 *     because a mirrored job cites the calendar record and so is not CSV-only).
 */

const HOLLIS = 'Hollis Creek Handyman'
const LOG_FILE = 'sources/spreadsheet/hollis_creek_job_log.csv'
const CSV_SOURCE = /job log|spreadsheet|csv/i
const CSV_ONLY = /\bonly\b|unconfirmed|not confirmed/i
const TENTATIVE = /tentative calendar hold/i

function key(source: Source): string {
  return `${source.sourceSystem} | ${source.sourceFile} | ${source.sourceRecordId}`
}

/** Every citation anywhere in a response body. */
function citations(body: unknown): Source[] {
  return collect(body, 'sources').flatMap(({ path: at, value }) =>
    arr(value, at).map((item, i) => {
      const source = obj(item, `${at}[${String(i)}]`)
      return {
        sourceSystem: str(source.sourceSystem, 'sourceSystem'),
        sourceFile: str(source.sourceFile, 'sourceFile'),
        sourceRecordId: str(source.sourceRecordId, 'sourceRecordId'),
      }
    }),
  )
}

function icsIds(body: unknown): string[] {
  return [
    ...new Set(
      citations(body)
        .filter((source) => source.sourceSystem === 'ics')
        .map((source) => source.sourceRecordId),
    ),
  ]
}

function openingsOf(body: Json): Json[] {
  return arr(body.openings, 'openings').map((o, i) => obj(o, `openings[${String(i)}]`))
}

function onDay(openings: Json[], day: string): Json[] {
  return openings.filter((o) => str(o.start, 'start').startsWith(day))
}

function reasonsOf(opening: Json): string[] {
  return arr(opening.reasons, 'reasons').map(String)
}

function citedIds(opening: Json): string[] {
  return citations({ sources: opening.sources ?? [] }).map((source) => source.sourceRecordId)
}

async function storedKeys(harness: McpHarness): Promise<Set<string>> {
  const { rows } = await harness.admin.query<{ s: string; f: string; r: string }>(
    `SELECT DISTINCT source_system AS s, source_file AS f, source_record_id AS r FROM source_records`,
  )
  return new Set(
    rows.map((row) => key({ sourceSystem: row.s, sourceFile: row.f, sourceRecordId: row.r })),
  )
}

async function answerOn(harness: McpHarness, name: string, args: Record<string, unknown>) {
  const result = await harness.call(name, args)
  expect(result.isError, `${name} failed: ${result.raw}`).toBe(false)
  return obj(result.body, `${name} body`)
}

/** Every page of a Q1 search, following nextCursor; fails after 50 pages. */
async function allQ1Pages(harness: McpHarness, args: Record<string, unknown>): Promise<Json[]> {
  const pages: Json[] = []
  let cursor: string | null | undefined
  while (cursor !== null) {
    if (pages.length >= 50) throw new Error('nextCursor never became null')
    const page = await answerOn(
      harness,
      'search_job_history_near_address',
      cursor === undefined ? args : { ...args, cursor },
    )
    pages.push(page)
    cursor = page.nextCursor === null ? null : str(page.nextCursor, 'nextCursor')
  }
  return pages
}

/** Citations in `bodies` that match no stored source record, for a readable failure. */
function untraced(bodies: unknown[], stored: Set<string>): string[] {
  return [...new Set(bodies.flatMap(citations).map(key))].filter((k) => !stored.has(k))
}

describe('calendar citations and CSV-only bookings (trace pack)', () => {
  let harness: McpHarness | undefined
  let hollisId = ''
  let stored = new Set<string>()

  function mcp(): McpHarness {
    if (harness === undefined) throw new Error('MCP harness did not start')
    return harness
  }

  function answer(name: string, args: Record<string, unknown>): Promise<Json> {
    return answerOn(mcp(), name, args)
  }

  function openings(from: string, to: string): Promise<Json> {
    return answer('get_provider_openings', { providerId: hollisId, from, to, limit: 50 })
  }

  /** ICS citations that match no stored ICS record exactly. */
  function unstoredIcs(body: unknown): string[] {
    return citations(body)
      .filter((source) => source.sourceSystem === 'ics' && !stored.has(key(source)))
      .map((source) => source.sourceRecordId)
  }

  function expectCitesStoredIcs(body: unknown, uids: string[]): void {
    const cited = icsIds(body)
    uids.forEach((uid) => {
      expect(
        cited.some((id) => id.startsWith(`${uid}@`)),
        `cites ${uid}`,
      ).toBe(true)
    })
    expect(unstoredIcs(body)).toEqual([])
  }

  beforeAll(async () => {
    harness = await startMcpHarness(TRACE_PACK_DIR)
    const profile = await answer('get_provider_profile', { providerName: HOLLIS, openingsLimit: 1 })
    hollisId = str(profile.providerId, 'providerId')
    stored = await storedKeys(mcp())
  })

  afterAll(async () => {
    await harness?.close()
  })

  describe('R19: a cited calendar record ID equals the stored source_record_id exactly', () => {
    it('R19: the pack stores one ICS record per occurrence, including the recurring lunch', async () => {
      const { rows } = await mcp().admin.query<{ r: string }>(
        `SELECT source_record_id AS r FROM source_records
          WHERE source_system = 'ics' AND source_record_id LIKE 'weekly-lunch-1@%'`,
      )
      expect(rows.length).toBeGreaterThan(1)
    })

    it('R19: get_provider_openings cites the recurring occurrence and both mirror events as stored', async () => {
      const body = await openings('2026-11-02', '2026-11-07')
      expectCitesStoredIcs(body, ['weekly-lunch-1', 'job-drywall-2', 'job-door-3'])
    })

    it('R19: get_provider_profile cites calendar records in nextOpenings as stored', async () => {
      const body = await answer('get_provider_profile', { providerId: hollisId, openingsLimit: 10 })
      expectCitesStoredIcs(body, ['weekly-lunch-1', 'job-drywall-2'])
    })

    it('R19: find_providers cites calendar records in its openings as stored', async () => {
      const body = await answer('find_providers', {
        trade: 'handyman',
        window: 'next_7_days',
        openingsLimit: 20,
      })
      expectCitesStoredIcs(body, ['weekly-lunch-1', 'job-drywall-2', 'job-door-3'])
    })

    it('R19: get_scheduled_work_on_block (Q3) cites the mirror events of its bookings as stored', async () => {
      const body = await answer('get_scheduled_work_on_block', {
        street: 'Tupelo Ave',
        blockNumber: 1400,
        zip: '75214',
        nextDays: 14,
      })
      expectCitesStoredIcs(body, ['job-drywall-2', 'job-door-3'])
    })

    it('R19: get_property_service_history cites the mirror event of an upcoming booking as stored', async () => {
      const body = await answer('get_property_service_history', {
        address: '1410 Tupelo Ave, Dallas, TX 75214',
      })
      expectCitesStoredIcs(body, ['job-drywall-2'])
    })

    it('R19: rank_providers_for_job cites only stored calendar records', async () => {
      const body = await answer('rank_providers_for_job', {
        trade: 'handyman',
        service: 'drywall patch',
        nearZip: '75214',
        window: 'this_week',
      })
      expect(unstoredIcs(body)).toEqual([])
    })
  })

  describe('R19: every citation in every tool response exists in source_records', () => {
    it('R19: all seven tools on the trace pack', async () => {
      const bodies = [
        ...(await allQ1Pages(mcp(), {
          address: '1410 Tupelo Ave, Dallas, TX 75214',
          radiusMiles: 1,
          lastMonths: 24,
          groupBy: 'trade',
        })),
        await openings('2026-11-02', '2026-11-16'),
        await answer('get_provider_profile', { providerId: hollisId, openingsLimit: 10 }),
        await answer('find_providers', {
          trade: 'handyman',
          window: 'next_14_days',
          openingsLimit: 20,
        }),
        await answer('get_scheduled_work_on_block', {
          street: 'Tupelo Ave',
          blockNumber: 1400,
          zip: '75214',
          nextDays: 14,
        }),
        await answer('get_property_service_history', {
          address: '1410 Tupelo Ave, Dallas, TX 75214',
        }),
        await answer('get_property_service_history', {
          address: '1420 Tupelo Ave, Dallas, TX 75214',
        }),
        await answer('rank_providers_for_job', {
          trade: 'handyman',
          service: 'drywall patch',
          nearZip: '75214',
          window: 'next_week',
        }),
      ]
      expect(bodies.flatMap(citations).length).toBeGreaterThan(0)
      expect(untraced(bodies, stored)).toEqual([])
    })
  })

  describe('G18: a CSV-only future booking (no calendar or CRM confirmation)', () => {
    function expectCsvOnlyLow(day: Json[]): void {
      expect(day.length, 'openings on Mon 11-02').toBeGreaterThan(0)
      day.forEach((opening) => {
        const what = `${str(opening.start, 'start')} opening`
        expect(opening.confidence, what).toBe('low')
        expect(citedIds(opening), what).toContain('row:4')
        expect(
          reasonsOf(opening).some((reason) => CSV_SOURCE.test(reason) && CSV_ONLY.test(reason)),
          `${what} names the booking as job-log only: ${reasonsOf(opening).join(' | ')}`,
        ).toBe(true)
      })
    }

    it('G18: still blocks its slot (no opening covers 13:00-14:00 on Mon 11-02)', async () => {
      const day = onDay(openingsOf(await openings('2026-11-02', '2026-11-03')), '2026-11-02')
      const covers = day.filter(
        (o) =>
          str(o.start, 'start') <= '2026-11-02T13:00:00-06:00' &&
          str(o.end, 'end') >= '2026-11-02T14:00:00-06:00',
      )
      expect(covers).toEqual([])
      expect(day.map((o) => o.start)).toContain('2026-11-02T08:00:00-06:00')
    })

    it('G18: get_provider_openings reports that day at low, citing the row, with a job-log-only reason', async () => {
      const day = onDay(openingsOf(await openings('2026-11-02', '2026-11-03')), '2026-11-02')
      expectCsvOnlyLow(day)
    })

    it('G18: find_providers shows that day at low, citing the row, with a job-log-only reason', async () => {
      const body = await answer('find_providers', {
        trade: 'handyman',
        window: 'next_3_days',
        openingsLimit: 20,
      })
      const hollis = arr(body.providers, 'providers')
        .map((p) => obj(p, 'provider'))
        .find((p) => p.providerId === hollisId)
      expect(hollis, `${HOLLIS} listed`).toBeDefined()
      expectCsvOnlyLow(onDay(openingsOf(hollis ?? {}), '2026-11-02'))
    })

    it('G18: the CSV-only row is a booking that cites only the job log', async () => {
      const body = await answer('get_property_service_history', {
        address: '1430 Tupelo Ave, Dallas, TX 75214',
      })
      const items = arr(body.items, 'items').map((item, i) => obj(item, `items[${String(i)}]`))
      expect(items).toHaveLength(1)
      const cited = citations(items[0])
      expect(cited.map((source) => source.sourceFile)).toEqual([LOG_FILE])
    })
  })

  describe('G18: a CSV row mirrored by a calendar event blocks at the calendar confidence', () => {
    it('G18: a CONFIRMED mirror keeps that day high and cites both the row and the event', async () => {
      const day = onDay(openingsOf(await openings('2026-11-04', '2026-11-05')), '2026-11-04')
      expect(day.map((o) => `${String(o.start)}/${String(o.end)}`)).toEqual([
        '2026-11-04T08:00:00-06:00/2026-11-04T09:00:00-06:00',
        '2026-11-04T11:00:00-06:00/2026-11-04T17:00:00-06:00',
      ])
      day.forEach((opening) => {
        expect(opening.confidence).toBe('high')
      })
      const after = day[1] ?? {}
      expect(citedIds(after)).toContain('row:5')
      expect(citedIds(after).some((id) => id.startsWith('job-drywall-2@'))).toBe(true)
    })

    it('G18: a TENTATIVE mirror lowers that day to low with the tentative-hold reason', async () => {
      const day = onDay(openingsOf(await openings('2026-11-05', '2026-11-06')), '2026-11-05')
      expect(day.map((o) => `${String(o.start)}/${String(o.end)}`)).toEqual([
        '2026-11-05T08:00:00-06:00/2026-11-05T09:00:00-06:00',
        '2026-11-05T11:00:00-06:00/2026-11-05T17:00:00-06:00',
      ])
      day.forEach((opening) => {
        expect(opening.confidence).toBe('low')
        expect(reasonsOf(opening).join(' | ')).toMatch(TENTATIVE)
      })
    })

    it('G18: no opening in the week is medium (a mirrored CSV booking is never medium)', async () => {
      const week = openingsOf(await openings('2026-11-02', '2026-11-07'))
      expect(week.filter((o) => o.confidence === 'medium')).toEqual([])
    })
  })
})

describe('R19: every citation in every tool response exists in source_records (fixture pack)', () => {
  let harness: McpHarness | undefined
  let stored = new Set<string>()
  let providerIds: string[] = []

  function mcp(): McpHarness {
    if (harness === undefined) throw new Error('MCP harness did not start')
    return harness
  }

  function answer(name: string, args: Record<string, unknown>): Promise<Json> {
    return answerOn(mcp(), name, args)
  }

  beforeAll(async () => {
    harness = await startMcpHarness(PACK_DIR)
    stored = await storedKeys(mcp())
    const { rows } = await mcp().admin.query<{ id: string }>(
      'SELECT id::text AS id FROM providers ORDER BY id',
    )
    providerIds = rows.map((row) => row.id)
  })

  afterAll(async () => {
    await harness?.close()
  })

  it('R19: search_job_history_near_address, every page', async () => {
    const pages = await allQ1Pages(mcp(), {
      address: '4512 Live Oak St, Dallas, TX 75204',
      radiusMiles: 0.5,
      lastMonths: 24,
      groupBy: 'trade',
      limit: 2,
    })
    expect(untraced(pages, stored)).toEqual([])
  })

  it('R19: get_provider_openings and get_provider_profile for every provider', async () => {
    const bodies = await Promise.all(
      providerIds.flatMap((providerId) => [
        answer('get_provider_openings', {
          providerId,
          from: '2026-11-02',
          to: '2026-11-16',
          limit: 50,
        }),
        answer('get_provider_profile', { providerId, openingsLimit: 10 }),
      ]),
    )
    const ics = bodies.flatMap(icsIds)
    expect(ics.length, 'some calendar citation (the weekly school pickup)').toBeGreaterThan(0)
    expect(untraced(bodies, stored)).toEqual([])
  })

  it('R19: find_providers for every trade in the pack', async () => {
    const bodies = await Promise.all(
      ['handyman', 'plumbing', 'pest'].map((trade) =>
        answer('find_providers', { trade, window: 'next_14_days', openingsLimit: 20 }),
      ),
    )
    expect(untraced(bodies, stored)).toEqual([])
  })

  it('R19: get_scheduled_work_on_block and get_property_service_history', async () => {
    const bodies = [
      await answer('get_scheduled_work_on_block', {
        street: 'Live Oak St',
        blockNumber: 4500,
        zip: '75204',
        nextDays: 14,
      }),
      await answer('get_property_service_history', {
        address: '5823 Belmont Ave, Dallas, TX 75206',
      }),
      await answer('get_property_service_history', {
        address: '4588 Live Oak St, Dallas, TX 75204',
      }),
    ]
    expect(untraced(bodies, stored)).toEqual([])
  })

  it('R19: rank_providers_for_job', async () => {
    const bodies = [
      await answer('rank_providers_for_job', {
        trade: 'plumbing',
        service: 'water heater replacement',
        nearZip: '75206',
        window: 'this_week',
      }),
      await answer('rank_providers_for_job', {
        trade: 'handyman',
        service: 'fence repair',
        nearZip: '75204',
        window: 'next_week',
      }),
    ]
    expect(untraced(bodies, stored)).toEqual([])
  })
})
