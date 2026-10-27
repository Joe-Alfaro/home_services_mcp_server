import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.ts'
import {
  arr,
  connectServer,
  num,
  obj,
  startMcpHarness,
  str,
  type Json,
  type McpHarness,
  type ServerConnection,
} from './support/mcp.ts'
import { FACTS_PACK_DIR } from './support/pack.ts'

/*
 * Facts computed by the adapters and the engine must reach the canonical tables, the read views and
 * the tools (G9, G17, G18, G20), and every relative window must come from the configured clock
 * (R14 b, G25). Runs on test/fixtures/facts_pack, a second invented pack, so the hand-computed
 * Q1-Q6 answers on test/fixtures/pack stay untouched. "Today" is 2026-11-02 unless a test builds a
 * server from loadConfig({ HS_TODAY, HS_NOW }).
 *
 * The pack:
 *   Cedar Hollow Heating & Air (hvac; profile Mon-Fri 8am-5pm, crew 1) with a CSV job log and an
 *   ICS calendar owned by the profile's owner:
 *     CSV row:4  Thu 11-05 09:00 "312 Wisteria Way" (no zip, street not in the reference)
 *     CSV row:5  Fri 11-06 10:00 "1460 Tupelo Ave"
 *     CSV row:6  Fri 11-06 15:00 "1475 Tupelo Ave", notes "Rescheduled from 11/3"
 *     ICS hold-furnace-1     Wed 11-04 10:00-12:00, STATUS:TENTATIVE
 *     ICS job-wisteria-2     Thu 11-05 09:00-11:00, LOCATION 312 Wisteria Way, Plano, TX 75093
 *     ICS job-tupelo-3       Fri 11-06 10:00-11:30, LOCATION 1470 Tupelo Ave, Dallas, TX 75214
 *   Nightjar Garage Doors (garage; profile hours "24/7 emergency service") on CRM A, one visit per
 *   job:
 *     completed Tue 10-20 09:00-12:00 and Tue 10-27 09:00-11:00, Thu 10-22 13:00-16:00 (local)
 *       → inferred hours Tue 09:00-12:00, Thu 13:00-16:00
 *     completed at 1530 Tupelo Ave: 2024-11-01 21:00-23:00 CDT (before the 24-month window),
 *       2024-11-02 00:30-01:30 CDT (first hour of it), 2024-11-08 10:00-11:00 CST, and 10-20 above
 *     scheduled at 1520 Tupelo Ave: 11-15 23:30, 11-16 00:30, 11-22 23:30, 11-23 00:30 (CST)
 *
 * Pinned additions to the read views and tools (extra fields are fine):
 *   calendar_blocks.status, v_calendar_blocks.status: 'confirmed' | 'tentative' | 'cancelled'
 *   jobs.rescheduled_from, v_jobs.rescheduled_from: date (local), null when not rescheduled
 *   declared_hours.always_open, v_declared_hours.always_open: boolean
 *   get_property_service_history items[].rescheduledFrom: "YYYY-MM-DD" | null
 */

const CEDAR = 'Cedar Hollow Heating & Air'
const NIGHTJAR = 'Nightjar Garage Doors'
const LOG_FILE = 'sources/spreadsheet/cedar_hollow_job_log.csv'

function span(opening: Json): string {
  return `${str(opening.start, 'start')}/${str(opening.end, 'end')}`
}

function openingsOf(body: Json): Json[] {
  return arr(body.openings, 'openings').map((o, i) => obj(o, `openings[${String(i)}]`))
}

function reasonsOf(opening: Json): string {
  return arr(opening.reasons, 'reasons').map(String).join(' | ')
}

/** The window a tool echoes, at the top level or under `query`. */
function windowOf(body: Json): Json {
  return obj(body.window ?? obj(body.query, 'query').window, 'window')
}

function citedIds(value: Json): string[] {
  return arr(value.sources ?? [], 'sources').map((s) =>
    str(obj(s, 'source').sourceRecordId, 'sourceRecordId'),
  )
}

describe('persisted facts and the configured clock, end to end (facts pack)', () => {
  let harness: McpHarness | undefined
  const providerIds = new Map<string, string>()

  function mcp(): McpHarness {
    if (harness === undefined) throw new Error('MCP harness did not start')
    return harness
  }

  async function answerOn(
    connection: Pick<ServerConnection, 'call'>,
    name: string,
    args: Record<string, unknown>,
  ): Promise<Json> {
    const result = await connection.call(name, args)
    expect(result.isError, `${name} failed: ${result.raw}`).toBe(false)
    return obj(result.body, `${name} body`)
  }

  function answer(name: string, args: Record<string, unknown>): Promise<Json> {
    return answerOn(mcp(), name, args)
  }

  function providerId(name: string): string {
    const id = providerIds.get(name)
    if (id === undefined) throw new Error(`no provider id for ${name}`)
    return id
  }

  async function openings(name: string, from: string, to: string): Promise<Json[]> {
    return openingsOf(
      await answer('get_provider_openings', {
        providerId: providerId(name),
        from,
        to,
        minMinutes: 15,
        limit: 50,
      }),
    )
  }

  /** The canonical job a source record is linked to. */
  async function jobIdOf(sourceRecordId: string): Promise<string> {
    const { rows } = await mcp().admin.query<{ job_id: string }>(
      `SELECT l.job_id FROM job_links l JOIN source_records sr ON sr.id = l.source_record_id
        WHERE sr.source_file = $1 AND sr.source_record_id = $2`,
      [LOG_FILE, sourceRecordId],
    )
    expect(rows, `job linked to ${sourceRecordId}`).toHaveLength(1)
    return rows[0]?.job_id ?? ''
  }

  /** The canonical block of an ICS event (one occurrence each in this pack). */
  async function blockOf(uid: string): Promise<{ id: string; mirrored_job_id: string | null }> {
    const { rows } = await mcp().admin.query<{ id: string; mirrored_job_id: string | null }>(
      `SELECT cb.id, cb.mirrored_job_id FROM calendar_blocks cb
         JOIN source_records sr ON sr.id = cb.source_record_id
        WHERE sr.source_system = 'ics' AND sr.source_record_id LIKE $1`,
      [`${uid}@%`],
    )
    expect(rows, `block of ${uid}`).toHaveLength(1)
    return rows[0] ?? { id: '', mirrored_job_id: null }
  }

  beforeAll(async () => {
    harness = await startMcpHarness(FACTS_PACK_DIR)
    const profiles = await Promise.all(
      [CEDAR, NIGHTJAR].map((name) =>
        answer('get_provider_profile', { providerName: name, openingsLimit: 1 }),
      ),
    )
    ;[CEDAR, NIGHTJAR].forEach((name, index) => {
      const body = obj(profiles[index], name)
      expect(str(body.name, 'name')).toContain(name)
      providerIds.set(name, str(body.providerId, 'providerId'))
    })
  })

  afterAll(async () => {
    await harness?.close()
  })

  describe('G17: a TENTATIVE calendar event', () => {
    it('G17: is persisted as tentative in calendar_blocks and v_calendar_blocks', async () => {
      const block = await blockOf('hold-furnace-1')
      const table = await mcp().admin.query<{ status: string }>(
        'SELECT status FROM calendar_blocks WHERE id = $1',
        [block.id],
      )
      expect(table.rows.map((row) => row.status)).toEqual(['tentative'])
      const view = await mcp().reader.query<{ status: string }>(
        'SELECT status FROM v_calendar_blocks WHERE id = $1',
        [block.id],
      )
      expect(view.rows.map((row) => row.status)).toEqual(['tentative'])
      const confirmed = await mcp().reader.query<{ status: string }>(
        'SELECT status FROM v_calendar_blocks WHERE id = $1',
        [(await blockOf('job-tupelo-3')).id],
      )
      expect(confirmed.rows.map((row) => row.status)).toEqual(['confirmed'])
    })

    it('G17: still blocks its slot, and get_provider_openings reports that day at low with a tentative-hold reason', async () => {
      const day = (await openings(CEDAR, '2026-11-04', '2026-11-05')).filter((o) =>
        str(o.start, 'start').startsWith('2026-11-04'),
      )
      expect(day.map(span)).toEqual([
        '2026-11-04T08:00:00-06:00/2026-11-04T10:00:00-06:00',
        '2026-11-04T12:00:00-06:00/2026-11-04T17:00:00-06:00',
      ])
      day.forEach((opening) => {
        expect(opening.confidence).toBe('low')
        expect(reasonsOf(opening)).toMatch(/tentative calendar hold/i)
      })
    })

    it('G17: does not lower the openings of other days', async () => {
      const tuesday = await openings(CEDAR, '2026-11-03', '2026-11-04')
      tuesday.forEach((opening) => {
        expect(reasonsOf(opening)).not.toMatch(/tentative/i)
      })
    })

    it('G17: find_providers shows the affected opening at low with the reason', async () => {
      const body = await answer('find_providers', {
        trade: 'hvac',
        minOpeningMinutes: 60,
        window: 'next_3_days',
      })
      const cedar = arr(body.providers, 'providers')
        .map((p) => obj(p, 'provider'))
        .find((p) => p.providerId === providerId(CEDAR))
      expect(cedar, 'Cedar Hollow listed').toBeDefined()
      const held = openingsOf(cedar ?? {}).find(
        (o) => o.start === '2026-11-04T08:00:00-06:00' && o.end === '2026-11-04T10:00:00-06:00',
      )
      expect(held, 'the 11-04 08:00-10:00 opening').toBeDefined()
      expect(held?.confidence).toBe('low')
      expect(reasonsOf(held ?? {})).toMatch(/tentative calendar hold/i)
    })
  })

  describe('G9: a job rescheduled from another day', () => {
    it('G9: persists rescheduled_from on the canonical job and in v_jobs', async () => {
      const id = await jobIdOf('row:6')
      const table = await mcp().admin.query<{ rescheduled_from: string | null }>(
        `SELECT to_char(rescheduled_from, 'YYYY-MM-DD') AS rescheduled_from FROM jobs WHERE id = $1`,
        [id],
      )
      expect(table.rows).toEqual([{ rescheduled_from: '2026-11-03' }])
      const view = await mcp().reader.query<{ rescheduled_from: string | null }>(
        `SELECT to_char(rescheduled_from, 'YYYY-MM-DD') AS rescheduled_from FROM v_jobs
          WHERE id = $1`,
        [id],
      )
      expect(view.rows).toEqual([{ rescheduled_from: '2026-11-03' }])
      const plain = await mcp().reader.query<{ rescheduled_from: string | null }>(
        'SELECT rescheduled_from FROM v_jobs WHERE id = $1',
        [await jobIdOf('row:5')],
      )
      expect(plain.rows).toEqual([{ rescheduled_from: null }])
    })

    it('G9: the old day (Tue 11-03) keeps its full opening', async () => {
      expect((await openings(CEDAR, '2026-11-03', '2026-11-04')).map(span)).toEqual([
        '2026-11-03T08:00:00-06:00/2026-11-03T17:00:00-06:00',
      ])
    })

    it('G9: get_property_service_history shows the date it moved from', async () => {
      const body = await answer('get_property_service_history', {
        address: '1475 Tupelo Ave, Dallas, TX 75214',
      })
      const items = arr(body.items, 'items').map((item) => obj(item, 'item'))
      expect(items.map((item) => [item.start, item.rescheduledFrom])).toEqual([
        ['2026-11-06T15:00:00-06:00', '2026-11-03'],
      ])
    })
  })

  describe('G20: a profile that declares 24/7 hours', () => {
    it('G20: persists always_open on declared_hours and v_declared_hours', async () => {
      const rows = async (db: 'admin' | 'reader', relation: string, id: string) =>
        (
          await mcp()[db].query<{ always_open: boolean }>(
            `SELECT always_open FROM ${relation} WHERE provider_id = $1`,
            [id],
          )
        ).rows.map((row) => row.always_open)
      const nightjar = await rows('admin', 'declared_hours', providerId(NIGHTJAR))
      expect(nightjar.length).toBeGreaterThan(0)
      expect(new Set(nightjar)).toEqual(new Set([true]))
      expect(new Set(await rows('reader', 'v_declared_hours', providerId(NIGHTJAR)))).toEqual(
        new Set([true]),
      )
      expect(new Set(await rows('reader', 'v_declared_hours', providerId(CEDAR)))).toEqual(
        new Set([false]),
      )
    })

    it('G20: get_provider_openings uses the observed hours at low with a 24/7 reason', async () => {
      const week = await openings(NIGHTJAR, '2026-11-02', '2026-11-09')
      expect(week.map(span)).toEqual([
        '2026-11-03T09:00:00-06:00/2026-11-03T12:00:00-06:00',
        '2026-11-05T13:00:00-06:00/2026-11-05T16:00:00-06:00',
      ])
      week.forEach((opening) => {
        expect(opening.confidence).toBe('low')
        expect(reasonsOf(opening)).toMatch(/24\/7/)
      })
    })
  })

  describe('G18: a calendar event and a CSV row for the same booking', () => {
    it('G18: the same house number and street, zip on one side only, is one booking', async () => {
      const job = await jobIdOf('row:4')
      expect((await blockOf('job-wisteria-2')).mirrored_job_id).toBe(job)
      const { rows } = await mcp().admin.query<{ method: string }>(
        `SELECT l.method FROM job_links l JOIN source_records sr ON sr.id = l.source_record_id
          WHERE l.job_id = $1 AND sr.source_system = 'ics'`,
        [job],
      )
      expect(rows.map((row) => row.method)).toEqual(['calendar_mirror'])
    })

    it('G18: the tool sees one booking that cites both the row and the event', async () => {
      const after = (await openings(CEDAR, '2026-11-05', '2026-11-06')).find(
        (o) => o.start === '2026-11-05T11:00:00-06:00',
      )
      expect(after, 'the 11-05 opening after the booking').toBeDefined()
      const cited = citedIds(after ?? {})
      expect(cited).toContain('row:4')
      expect(cited.some((id) => id.startsWith('job-wisteria-2@'))).toBe(true)
    })

    it('G18: a genuinely different known address stays a separate booking', async () => {
      expect((await blockOf('job-tupelo-3')).mirrored_job_id).toBeNull()
    })
  })

  describe('R14 (b), G25: relative windows come from HS_TODAY and HS_NOW', () => {
    const connections: ServerConnection[] = []

    /** A server on the same database whose clock comes from loadConfig, as `npm start` does. */
    async function serverAt(env: Record<string, string>): Promise<ServerConnection> {
      const config = loadConfig(env)
      const connection = await connectServer(mcp().reader, {
        today: config.today,
        now: config.now,
      })
      connections.push(connection)
      return connection
    }

    afterAll(async () => {
      await Promise.all(connections.map((connection) => connection.close()))
    })

    async function hvac(connection: Pick<ServerConnection, 'call'>, window: string) {
      const body = await answerOn(connection, 'find_providers', {
        trade: 'hvac',
        minOpeningMinutes: 60,
        window,
      })
      const cedar = arr(body.providers, 'providers')
        .map((p) => obj(p, 'provider'))
        .find((p) => p.providerId === providerId(CEDAR))
      return { window: windowOf(body), openings: openingsOf(cedar ?? {}) }
    }

    function expectInside(openingsList: Json[], from: string, to: string): void {
      expect(openingsList.length).toBeGreaterThan(0)
      openingsList.forEach((opening) => {
        expect(Date.parse(str(opening.start, 'start'))).toBeGreaterThanOrEqual(Date.parse(from))
        expect(Date.parse(str(opening.end, 'end'))).toBeLessThanOrEqual(Date.parse(to))
      })
    }

    it('R14(b): "next 3 days" is [today 00:00, today+3 00:00) and moves with HS_TODAY=2026-11-09', async () => {
      const base = await hvac(mcp(), 'next_3_days')
      expect([base.window.from, base.window.to]).toEqual([
        '2026-11-02T00:00:00-06:00',
        '2026-11-05T00:00:00-06:00',
      ])
      expectInside(base.openings, '2026-11-02T00:00:00-06:00', '2026-11-05T00:00:00-06:00')
      expect(base.openings[0]?.start).toBe('2026-11-02T08:00:00-06:00')

      const moved = await hvac(await serverAt({ HS_TODAY: '2026-11-09' }), 'next_3_days')
      expect([moved.window.from, moved.window.to]).toEqual([
        '2026-11-09T00:00:00-06:00',
        '2026-11-12T00:00:00-06:00',
      ])
      expectInside(moved.openings, '2026-11-09T00:00:00-06:00', '2026-11-12T00:00:00-06:00')
      expect(moved.openings.map(span)).toEqual([
        '2026-11-09T08:00:00-06:00/2026-11-09T17:00:00-06:00',
        '2026-11-10T08:00:00-06:00/2026-11-10T17:00:00-06:00',
        '2026-11-11T08:00:00-06:00/2026-11-11T17:00:00-06:00',
      ])
    })

    it('R14(b): openings never start before HS_NOW', async () => {
      const late = await hvac(
        await serverAt({ HS_TODAY: '2026-11-09', HS_NOW: '2026-11-10T10:30' }),
        'next_3_days',
      )
      expect(late.window.from).toBe('2026-11-09T00:00:00-06:00')
      expect(late.openings.map(span)).toEqual([
        '2026-11-10T10:30:00-06:00/2026-11-10T17:00:00-06:00',
        '2026-11-11T08:00:00-06:00/2026-11-11T17:00:00-06:00',
      ])
    })

    it('R14(b), G25: "this week" is Monday to Sunday containing HS_TODAY', async () => {
      const base = await hvac(mcp(), 'this_week')
      expect([base.window.from, base.window.to]).toEqual([
        '2026-11-02T00:00:00-06:00',
        '2026-11-09T00:00:00-06:00',
      ])
      const monday = await hvac(await serverAt({ HS_TODAY: '2026-11-09' }), 'this_week')
      const wednesday = await hvac(await serverAt({ HS_TODAY: '2026-11-11' }), 'this_week')
      ;[monday, wednesday].forEach(({ window }) => {
        expect([window.from, window.to]).toEqual([
          '2026-11-09T00:00:00-06:00',
          '2026-11-16T00:00:00-06:00',
        ])
      })
      expect(wednesday.openings[0]?.start).toBe('2026-11-11T08:00:00-06:00')
    })

    async function block1500(connection: Pick<ServerConnection, 'call'>) {
      const body = await answerOn(connection, 'get_scheduled_work_on_block', {
        street: 'Tupelo Ave',
        blockNumber: 1500,
        zip: '75214',
        nextDays: 14,
      })
      const window = windowOf(body)
      const starts = arr(body.items, 'items')
        .map((item) => str(obj(item, 'item').start, 'start'))
        .sort()
      return { window: [window.from, window.to], starts }
    }

    it('G25: "next 14 days" ends at local midnight: 23:30 on the last day is in, 00:30 after is out', async () => {
      expect(await block1500(mcp())).toEqual({
        window: ['2026-11-02T00:00:00-06:00', '2026-11-16T00:00:00-06:00'],
        starts: ['2026-11-15T23:30:00-06:00'],
      })
      expect(await block1500(await serverAt({ HS_TODAY: '2026-11-09' }))).toEqual({
        window: ['2026-11-09T00:00:00-06:00', '2026-11-23T00:00:00-06:00'],
        starts: [
          '2026-11-15T23:30:00-06:00',
          '2026-11-16T00:30:00-06:00',
          '2026-11-22T23:30:00-06:00',
        ],
      })
    })

    async function garageHistory(connection: Pick<ServerConnection, 'call'>) {
      const body = await answerOn(connection, 'search_job_history_near_address', {
        address: '1530 Tupelo Ave, Dallas, TX 75214',
        radiusMiles: 0.05,
        lastMonths: 24,
        groupBy: 'trade',
      })
      const window = windowOf(body)
      const garage = arr(body.groups, 'groups')
        .map((group) => obj(group, 'group'))
        .find((group) => group.trade === 'garage')
      return {
        window: [window.fromDate, window.toDateExclusive, window.from, window.to],
        count: garage === undefined ? 0 : num(garage.count, 'count'),
      }
    }

    it('G25: "last 24 months" is [today - 24 months, today) in local dates and moves with HS_TODAY', async () => {
      // 2024-11-01 23:00 CDT is out; 2024-11-02 01:30 CDT and 2024-11-08 are in; so is 2026-10-20.
      expect(await garageHistory(mcp())).toEqual({
        window: [
          '2024-11-02',
          '2026-11-02',
          '2024-11-02T00:00:00-05:00',
          '2026-11-02T00:00:00-06:00',
        ],
        count: 3,
      })
      expect(await garageHistory(await serverAt({ HS_TODAY: '2026-11-09' }))).toEqual({
        window: [
          '2024-11-09',
          '2026-11-09',
          '2024-11-09T00:00:00-06:00',
          '2026-11-09T00:00:00-06:00',
        ],
        count: 1,
      })
    })
  })
})
