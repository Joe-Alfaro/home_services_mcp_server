import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { citationExists, type Source } from './support/pack.ts'
import {
  arr,
  collect,
  dateTimes,
  num,
  obj,
  startMcpHarness,
  str,
  TOOL_NAMES,
  type Json,
  type McpHarness,
} from './support/mcp.ts'

/*
 * M2 MCP tools (R15, R18, R19, R21) through an in-memory MCP client, on a server built over the
 * ingested fixture pack (test/fixtures/pack) and connected as the read-only role. Entry points:
 * ./support/pack.ts. "Today" is 2026-11-02 and "now" 2026-11-02T00:00 America/Chicago.
 *
 * Pinned tool inputs (zod; extra optional parameters are fine):
 *   search_job_history_near_address { address, radiusMiles (0 < r <= 5), lastMonths, groupBy: 'trade',
 *                                     limit?, cursor?, trade? }   (paging: q1Summary.test.ts)
 *   find_providers                  { trade (enum of TRADES), workedInZip?, nearZip?,
 *                                     minOpeningMinutes?, window?: 'next_3_days' | 'this_week' | ... }
 *   get_scheduled_work_on_block     { street, blockNumber, zip?, nextDays (1..30) }
 *   get_provider_profile            { providerName | providerId, openingsLimit (1..10), minMinutes? }
 *   get_property_service_history    { address (non-empty) }
 *   rank_providers_for_job          { trade, service (free text), nearZip (5 digits), window }
 *   get_provider_openings           { providerId, from, to (YYYY-MM-DD local days, to exclusive),
 *                                     minMinutes? (bounded, default 30), limit? }
 *
 * Pinned response fields (each tool's JSON body; extra fields are fine):
 *   Source   = { sourceSystem, sourceFile, sourceRecordId }; every item has `sources: Source[]`.
 *   Provider = { providerId, name } on items as `provider`.
 *   Opening  = { start, end, minutes, confidence: 'high'|'medium'|'low', reasons: string[] }.
 *   Every date-time string is ISO-8601 with a -05:00 or -06:00 offset, never "Z" (R12 e).
 *   Q1 { total, groups: [{ trade, count, sampleJobs: Job[1..3], sources }], jobs: Job[] (one
 *        page), nextCursor }   Job = { provider, trade, block, zip, sources }
 *   Q2 { providers: [{ providerId, name, trades, openings: Opening[], sources }] }
 *   Q3 { block, items: [{ kind, status, start, provider, trade, block, zip, sources }] }
 *   Q4 { providerId, name, trades, serviceArea: { declaredZips, observedZips },
 *        history: { completed, cancelled }, nextOpenings: Opening[], conflicts: [{ kind, sources }],
 *        sources }   (history.completed counts completed jobs and visits, never estimates)
 *   Q5 { items: [{ provider, kind, status, start, trade, sources }] }   (one item per service)
 *   Q6 { ranking: [{ rank, providerId, name, score, factors: [{ name, sources }], sources }] }
 *   openings { openings: Opening[] }
 *
 * Hand-computed answers on the fixture (house numbers interpolated along invented segments,
 * 100-number blocks ~234 m long on Live Oak St; 804.7 m = half a mile):
 *   Q1 4512 Live Oak St 75204, 0.5 mi, 24 months → plumbing 2 (CRM C 4541 "Leak repair"
 *      2025-06-18; CRM A 4790 "Sewer line camera" 2025-12-01, 650 m), handyman 2 (CSV 4588
 *      "fence repair" 2026-03-03; CRM A 3450 Cole Ave "TV mount" 2026-08-20, 335 m), pest 1 (one
 *      CRM A job with two completed visits). Excluded: a cancelled job and a completed estimate
 *      on the block, 4612 work from 2024-10-15, 4925 (965 m), Elm St (1.2 km), Garland (no
 *      geocode), and future bookings.
 *   Q2 handyman, worked in 75214, >= 120 min in [11-02, 11-05) → Lakeside Handyman only (its
 *      75214 job was booked under its old name). Openings 11-02 11:00-17:00, 11-03 08:00-17:00,
 *      11-04 08:00-17:00. Bishop Arts' longest gap is 90 min; Larkspur is out all three days
 *      on its calendar.
 *   Q3 4500 block of Live Oak St, next 14 days → 4 items: CRM B job 11-06 10:00, CRM B estimate
 *      11-10 09:00 (kind estimate), CSV job 11-12 14:00 (two identical rows, one item), CRM A visit
 *      11-15 23:30. Not: the cancelled 11-04 visit, the 11-16 00:30 visit, other blocks.
 *   Q4 Pecan Valley Plumbing → trades [plumbing]; declared 75204, 75206; observed 75204, 75206,
 *      75214 (service_area conflict); 4 completed, 1 cancelled; next openings 11-02 12:00-17:00,
 *      11-03 08:00-17:00, 11-04 08:00-17:00; sources from CRM C, CRM B and the profile.
 *   Q5 5823 Belmont Ave 75206 → 6 items: completed 2025-03-12 and 2026-02-10 (Pecan Valley
 *      Plumbing; the second cites its approved estimate), 2025-11-20 (Larkspur Handyman, CSV
 *      row twice, zip inferred), 2026-07-14 (Mockingbird); cancelled 2026-09-01 (Bishop Arts);
 *      scheduled 2026-11-02 (Pecan Valley Plumbing). Not: Apt B, 5823 Juniper Ave.
 *   Q6 plumbing, water heater replacement, near 75206, this week → all three plumbers ranked;
 *      Pecan Valley Plumbing (3 replacements, declares 75206) above Sumac Creek Rooter (no
 *      water-heater history, does not declare 75206), which ranks last.
 */

const Q1_ADDRESS = '4512 Live Oak St, Dallas, TX 75204'
const Q5_ADDRESS = '5823 Belmont Ave, Dallas, TX 75206'
const CONFIDENCES = ['high', 'medium', 'low']
const OFFSET_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?-0[56]:00$/

function sourcesOf(item: unknown, what: string): Source[] {
  const sources = arr(obj(item, what).sources, `${what}.sources`)
  expect(sources.length, `${what} has sources`).toBeGreaterThan(0)
  return sources.map((source, index) => {
    const value = obj(source, `${what}.sources[${String(index)}]`)
    return {
      sourceSystem: str(value.sourceSystem, 'sourceSystem'),
      sourceFile: str(value.sourceFile, 'sourceFile'),
      sourceRecordId: str(value.sourceRecordId, 'sourceRecordId'),
    }
  })
}

function providerName(item: Json): string {
  return str(obj(item.provider, 'provider').name, 'provider.name')
}

function expectOffsetTimes(body: unknown): void {
  const bad = dateTimes(body).filter(({ value }) => !OFFSET_TIME.test(value))
  expect(bad).toEqual([])
}

function expectOpening(value: unknown, what: string): Json {
  const opening = obj(value, what)
  expect(str(opening.start, `${what}.start`)).toMatch(OFFSET_TIME)
  expect(str(opening.end, `${what}.end`)).toMatch(OFFSET_TIME)
  expect(num(opening.minutes, `${what}.minutes`)).toBeGreaterThan(0)
  expect(CONFIDENCES).toContain(opening.confidence)
  arr(opening.reasons, `${what}.reasons`)
  return opening
}

function span(opening: Json): string {
  return `${String(opening.start)}/${String(opening.end)}`
}

describe('MCP tools on the fixture pack (M2)', () => {
  let harness: McpHarness | undefined

  function mcp(): McpHarness {
    if (harness === undefined) throw new Error('MCP harness did not start')
    return harness
  }

  async function answer(name: string, args: Record<string, unknown>): Promise<Json> {
    const result = await mcp().call(name, args)
    expect(result.isError, `${name} failed: ${result.raw}`).toBe(false)
    expectOffsetTimes(result.body)
    return obj(result.body, `${name} body`)
  }

  beforeAll(async () => {
    harness = await startMcpHarness()
  })

  afterAll(async () => {
    await harness?.close()
  })

  describe('tool list and schemas (R15 a, R18 a-b)', () => {
    it('lists exactly the tools in ARCHITECTURE.md', async () => {
      const { tools } = await mcp().client.listTools()
      expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES])
    })

    it('describes when to use each tool, when not to (naming the better tool) and an example', async () => {
      const { tools } = await mcp().client.listTools()
      tools.forEach((tool) => {
        const description = tool.description ?? ''
        expect(description, tool.name).toMatch(/\bwhen\b/i)
        expect(description, tool.name).toMatch(/\b(do not|don't|not for|instead)\b/i)
        const others = TOOL_NAMES.filter((name) => name !== tool.name)
        expect(
          others.some((name) => description.includes(name)),
          `${tool.name} names a better tool`,
        ).toBe(true)
        expect(description, tool.name).toMatch(/example/i)
      })
    })

    it('documents every parameter', async () => {
      const { tools } = await mcp().client.listTools()
      tools.forEach((tool) => {
        const properties = Object.entries(tool.inputSchema.properties ?? {})
        expect(properties.length, tool.name).toBeGreaterThan(0)
        properties.forEach(([name, schema]) => {
          const description = obj(schema, `${tool.name}.${name}`).description
          expect(
            typeof description === 'string' && description.length > 0,
            `${tool.name}.${name}`,
          ).toBe(true)
        })
      })
    })

    it('uses an enum for trades', async () => {
      const { tools } = await mcp().client.listTools()
      const trade = obj(
        obj(tools.find((tool) => tool.name === 'find_providers')?.inputSchema.properties, 'props')
          .trade,
        'find_providers.trade',
      )
      expect(arr(trade.enum, 'trade.enum')).toEqual(
        expect.arrayContaining(['handyman', 'plumbing', 'hvac', 'pest']),
      )
    })
  })

  describe('invalid input names the field and the accepted values (R18 c)', () => {
    it.each([
      [
        'search_job_history_near_address',
        { address: Q1_ADDRESS, radiusMiles: 50, lastMonths: 24, groupBy: 'trade' },
        [/radiusMiles/, /\b5\b/],
      ],
      [
        'find_providers',
        { trade: 'carpentry', workedInZip: '75214', minOpeningMinutes: 120, window: 'next_3_days' },
        [/trade/, /handyman/, /plumbing/],
      ],
      [
        'get_scheduled_work_on_block',
        { street: 'Live Oak St', blockNumber: 4500, zip: '75204', nextDays: 90 },
        [/nextDays/, /\b30\b/],
      ],
      [
        'get_provider_profile',
        { providerName: 'Pecan Valley Plumbing', openingsLimit: 50 },
        [/openingsLimit/, /\b10\b/],
      ],
      ['get_property_service_history', { address: '' }, [/address/]],
      [
        'rank_providers_for_job',
        {
          trade: 'plumbing',
          service: 'water heater replacement',
          nearZip: '7520',
          window: 'this_week',
        },
        [/nearZip/, /5.?digit/i],
      ],
      [
        'get_provider_openings',
        { providerId: '1', from: 'tomorrow', to: '2026-11-05' },
        [/\bfrom\b/, /YYYY-MM-DD|ISO/],
      ],
    ] as const)('%s', async (name, args, patterns) => {
      const result = await mcp().call(name, { ...args })
      expect(result.isError).toBe(true)
      patterns.forEach((pattern) => {
        expect(result.raw).toMatch(pattern)
      })
    })
  })

  describe('Q1: history near an address, grouped by trade', () => {
    let body: Json

    beforeAll(async () => {
      body = await answer('search_job_history_near_address', {
        address: Q1_ADDRESS,
        radiusMiles: 0.5,
        lastMonths: 24,
        groupBy: 'trade',
      })
    })

    it('counts completed work within half a mile in the last 24 months by trade', () => {
      const groups = arr(body.groups, 'groups').map((group, index) =>
        obj(group, `groups[${String(index)}]`),
      )
      const counts = Object.fromEntries(
        groups.map((group) => [str(group.trade, 'trade'), num(group.count, 'count')]),
      )
      expect(counts).toEqual({ plumbing: 2, handyman: 2, pest: 1 })
      expect(body.total).toBe(5)
      // At most 3 samples per trade, so each of these small groups shows all of its jobs.
      groups.forEach((group) => {
        expect(arr(group.sampleJobs, 'sampleJobs')).toHaveLength(num(group.count, 'count'))
      })
    })

    it('lists all five jobs on the first page of the job list', () => {
      expect(arr(body.jobs, 'jobs')).toHaveLength(5)
      expect(body.nextCursor).toBeNull()
    })

    it('cites sources and shows block and zip, not other house numbers', () => {
      const jobs = [
        ...arr(body.groups, 'groups').flatMap((group) =>
          arr(obj(group, 'group').sampleJobs, 'sampleJobs'),
        ),
        ...arr(body.jobs, 'jobs'),
      ]
      jobs.forEach((job, index) => {
        sourcesOf(job, `jobs[${String(index)}]`)
        expect(obj(job, 'job').zip).toMatch(/^\d{5}$/)
        expect(String(obj(job, 'job').block)).toMatch(/^\d+00 block of /)
      })
      expect(JSON.stringify(body)).not.toMatch(/\b(4518|4533|4541|4588|4790|3450|4612|4925)\b/)
    })

    it('counts the two completed visits of one CRM A job once', () => {
      const pest = arr(body.groups, 'groups')
        .map((group) => obj(group, 'group'))
        .find((group) => group.trade === 'pest')
      const visits = sourcesOf(arr(pest?.sampleJobs, 'pest sampleJobs')[0], 'pest job').map(
        (source) => source.sourceRecordId,
      )
      expect(visits).toEqual(expect.arrayContaining(['visit-pvpest-01', 'visit-pvpest-02']))
    })
  })

  describe('Q2: handymen who worked in 75214 with a 2-hour opening in the next 3 days', () => {
    let body: Json

    beforeAll(async () => {
      body = await answer('find_providers', {
        trade: 'handyman',
        workedInZip: '75214',
        minOpeningMinutes: 120,
        window: 'next_3_days',
      })
    })

    it('lists only the rebranded handyman, once', () => {
      const providers = arr(body.providers, 'providers').map((p) => obj(p, 'provider'))
      expect(providers.map((p) => str(p.name, 'name'))).toEqual([
        expect.stringMatching(/Lakeside Handyman/),
      ])
      expect(JSON.stringify(providers)).toContain('sources/jobber/bluestem_fix_it.json')
    })

    it('gives each opening >= 120 minutes inside the window with a confidence', () => {
      const [provider] = arr(body.providers, 'providers').map((p) => obj(p, 'provider'))
      sourcesOf(provider, 'provider')
      const openings = arr(provider?.openings, 'openings').map((o, i) =>
        expectOpening(o, `openings[${String(i)}]`),
      )
      expect(openings.map(span)).toEqual(
        expect.arrayContaining(['2026-11-02T11:00:00-06:00/2026-11-02T17:00:00-06:00']),
      )
      openings.forEach((opening) => {
        expect(num(opening.minutes, 'minutes')).toBeGreaterThanOrEqual(120)
        expect(Date.parse(str(opening.start, 'start'))).toBeGreaterThanOrEqual(
          Date.parse('2026-11-02T00:00:00-06:00'),
        )
        expect(Date.parse(str(opening.end, 'end'))).toBeLessThanOrEqual(
          Date.parse('2026-11-05T00:00:00-06:00'),
        )
      })
    })
  })

  describe('Q3: scheduled work on the 4500 block of Live Oak St in the next 14 days', () => {
    let body: Json

    beforeAll(async () => {
      body = await answer('get_scheduled_work_on_block', {
        street: 'Live Oak St',
        blockNumber: 4500,
        zip: '75204',
        nextDays: 14,
      })
    })

    it('returns the four bookings, the estimate labelled, cancelled work excluded', () => {
      const items = arr(body.items, 'items').map((item) => obj(item, 'item'))
      expect(items.map((item) => item.start).sort()).toEqual([
        '2026-11-06T10:00:00-06:00',
        '2026-11-10T09:00:00-06:00',
        '2026-11-12T14:00:00-06:00',
        '2026-11-15T23:30:00-06:00',
      ])
      const estimate = items.find((item) => item.start === '2026-11-10T09:00:00-06:00')
      expect(estimate?.kind).toBe('estimate')
      items
        .filter((item) => item !== estimate)
        .forEach((item) => {
          expect(item.kind).not.toBe('estimate')
        })
      items.forEach((item) => {
        expect(['scheduled', 'in_progress']).toContain(item.status)
      })
      const cited = items.flatMap((item, i) => sourcesOf(item, `items[${String(i)}]`))
      expect(cited.map((source) => source.sourceRecordId)).not.toContain('visit-pvpest-03')
    })

    it('shows the block, never a house number', () => {
      expect(body.block).toBe('4500 block of Live Oak St')
      arr(body.items, 'items').forEach((item) => {
        expect(obj(item, 'item').block).toBe('4500 block of Live Oak St')
        expect(obj(item, 'item').zip).toBe('75204')
      })
      expect(JSON.stringify(body)).not.toMatch(/\b(4518|4533|4541|4588)\b/)
    })
  })

  describe('Q4: everything about the plumber that moved CRMs', () => {
    let body: Json

    beforeAll(async () => {
      body = await answer('get_provider_profile', {
        providerName: 'Pecan Valley Plumbing',
        openingsLimit: 3,
      })
    })

    it('resolves the name to the plumber, not the pest business with the same prefix', () => {
      expect(str(body.name, 'name')).toMatch(/Pecan Valley Plumbing/)
      expect(body.trades).toEqual(['plumbing'])
      expect(JSON.stringify(body)).not.toMatch(/pecan_valley_pest|Pest Control/)
    })

    it('shows declared and observed service zips side by side', () => {
      const area = obj(body.serviceArea, 'serviceArea')
      expect([...arr(area.declaredZips, 'declaredZips')].sort()).toEqual(['75204', '75206'])
      expect([...arr(area.observedZips, 'observedZips')].sort()).toEqual([
        '75204',
        '75206',
        '75214',
      ])
    })

    it('summarizes history across both CRM accounts', () => {
      const history = obj(body.history, 'history')
      expect(history.completed).toBe(4)
      expect(history.cancelled).toBe(1)
      const systems = new Set(sourcesOf(body, 'profile').map((source) => source.sourceSystem))
      expect(systems).toEqual(new Set(['workiz', 'housecall_pro', 'profiles']))
    })

    it('gives the next 3 openings with confidence', () => {
      const openings = arr(body.nextOpenings, 'nextOpenings').map((o, i) =>
        expectOpening(o, `nextOpenings[${String(i)}]`),
      )
      expect(openings.map(span)).toEqual([
        '2026-11-02T12:00:00-06:00/2026-11-02T17:00:00-06:00',
        '2026-11-03T08:00:00-06:00/2026-11-03T17:00:00-06:00',
        '2026-11-04T08:00:00-06:00/2026-11-04T17:00:00-06:00',
      ])
    })

    it('reports the undeclared-zip conflict with sources', () => {
      const conflicts = arr(body.conflicts, 'conflicts').map((c) => obj(c, 'conflict'))
      const serviceArea = conflicts.filter((conflict) => conflict.kind === 'service_area')
      expect(JSON.stringify(serviceArea)).toContain('75214')
      serviceArea.forEach((conflict, i) => sourcesOf(conflict, `conflicts[${String(i)}]`))
    })
  })

  describe('Q5: service history of one home', () => {
    let body: Json
    let items: Json[]

    beforeAll(async () => {
      body = await answer('get_property_service_history', { address: Q5_ADDRESS })
      items = arr(body.items, 'items').map((item) => obj(item, 'item'))
    })

    it('lists each completed service once with provider and date', () => {
      const completed = items
        .filter((item) => item.status === 'completed')
        .map((item) => `${String(item.start).slice(0, 10)} ${providerName(item)}`)
        .sort()
      expect(completed).toEqual([
        expect.stringMatching(/^2025-03-12 .*Pecan Valley Plumbing/),
        expect.stringMatching(/^2025-11-20 .*Larkspur Handyman/),
        expect.stringMatching(/^2026-02-10 .*Pecan Valley Plumbing/),
        expect.stringMatching(/^2026-07-14 .*Mockingbird/),
      ])
      items
        .filter((item) => item.status === 'completed')
        .forEach((item) => {
          expect(item.kind).not.toBe('estimate')
        })
    })

    it('labels the cancelled and the upcoming job instead of counting them', () => {
      expect(items).toHaveLength(6)
      const cancelled = items.filter((item) => item.status === 'cancelled')
      expect(
        cancelled.map((item) => `${String(item.start).slice(0, 10)} ${providerName(item)}`),
      ).toEqual([expect.stringMatching(/^2026-09-01 .*Bishop Arts Handyman/)])
      const upcoming = items.filter((item) => item.status === 'scheduled')
      expect(upcoming.map((item) => item.start)).toEqual(['2026-11-02T08:00:00-06:00'])
    })

    it('cites the approved estimate on the job created from it (G5)', () => {
      const replaced = items.find((item) => String(item.start).startsWith('2026-02-10'))
      expect(sourcesOf(replaced, 'replacement').map((source) => source.sourceRecordId)).toEqual(
        expect.arrayContaining(['job-pv-01', 'est-pv-01']),
      )
    })

    it('excludes the unit and the same number on another street (G24, G28)', () => {
      const cited = items.flatMap((item, i) => sourcesOf(item, `items[${String(i)}]`))
      const ids = cited.map((source) => source.sourceRecordId)
      expect(ids).not.toContain('visit-lakeside-02')
      expect(ids).not.toContain('visit-mock-04')
    })

    it('echoes the supplied house number and no homeowner identity', () => {
      expect(JSON.stringify(body)).toContain('5823')
      expect(JSON.stringify(body)).not.toMatch(/Quennell|Thackeray/i)
    })

    it('cites records that exist in the cited fixture files (R19 b)', () => {
      const cited = items.flatMap((item, i) => sourcesOf(item, `items[${String(i)}]`))
      cited.forEach((source) => {
        expect(citationExists(source), JSON.stringify(source)).toBe(true)
      })
    })
  })

  describe('Q6: ranked plumbers for a water heater replacement near 75206 this week (R21)', () => {
    let ranking: Json[]

    beforeAll(async () => {
      const body = await answer('rank_providers_for_job', {
        trade: 'plumbing',
        service: 'water heater replacement',
        nearZip: '75206',
        window: 'this_week',
      })
      ranking = arr(body.ranking, 'ranking').map((entry) => obj(entry, 'entry'))
    })

    function indexOf(pattern: RegExp): number {
      return ranking.findIndex((entry) => pattern.test(str(entry.name, 'name')))
    }

    it('ranks every plumber and no one else', () => {
      expect(ranking).toHaveLength(3)
      expect(indexOf(/Pecan Valley Plumbing/)).toBeGreaterThanOrEqual(0)
      expect(indexOf(/Mockingbird/)).toBeGreaterThanOrEqual(0)
      expect(indexOf(/Sumac Creek Rooter/)).toBe(2)
      expect(JSON.stringify(ranking)).not.toMatch(/Handyman|Pest/)
    })

    it('orders entries by score with ranks 1..n', () => {
      const scores = ranking.map((entry) => num(entry.score, 'score'))
      expect(scores).toEqual([...scores].sort((a, b) => b - a))
      expect(ranking.map((entry) => entry.rank)).toEqual([1, 2, 3])
    })

    it('explains each score with factors that all cite sources', () => {
      ranking.forEach((entry, i) => {
        sourcesOf(entry, `ranking[${String(i)}]`)
        const factors = arr(entry.factors, 'factors').map((f) => obj(f, 'factor'))
        expect(factors.length).toBeGreaterThan(0)
        factors.forEach((factor, j) => {
          str(factor.name, 'factor.name')
          sourcesOf(factor, `ranking[${String(i)}].factors[${String(j)}]`)
        })
        const text = JSON.stringify(factors)
        expect(text).toMatch(/water.?heater/i)
        expect(text).toMatch(/zip|distance|area/i)
        expect(text).toMatch(/opening/i)
      })
    })

    it('backs the leader with its water-heater replacements and marks the plumber with none', () => {
      const pecan = JSON.stringify(ranking[indexOf(/Pecan Valley Plumbing/)])
      ;['PV5823A', 'PV1250A', 'job-pv-01'].forEach((id) => {
        expect(pecan).toContain(id)
      })
      expect(indexOf(/Pecan Valley Plumbing/)).toBeLessThan(indexOf(/Sumac Creek Rooter/))
      expect(JSON.stringify(ranking[2])).toMatch(/no water.?heater history/i)
    })
  })

  describe('get_provider_openings', () => {
    it('returns the openings of one provider in a window', async () => {
      const q2 = await answer('find_providers', {
        trade: 'handyman',
        workedInZip: '75214',
        minOpeningMinutes: 120,
        window: 'next_3_days',
      })
      const providerId = obj(arr(q2.providers, 'providers')[0], 'provider').providerId
      const body = await answer('get_provider_openings', {
        providerId,
        from: '2026-11-02',
        to: '2026-11-05',
        minMinutes: 120,
        limit: 10,
      })
      const openings = arr(body.openings, 'openings').map((o, i) =>
        expectOpening(o, `openings[${String(i)}]`),
      )
      expect(openings.map(span)).toEqual([
        '2026-11-02T11:00:00-06:00/2026-11-02T17:00:00-06:00',
        '2026-11-03T08:00:00-06:00/2026-11-03T17:00:00-06:00',
        '2026-11-04T08:00:00-06:00/2026-11-04T17:00:00-06:00',
      ])
    })
  })

  describe('R18 b: minMinutes filters openings (bounded, default 30)', () => {
    async function providerId(name: string): Promise<unknown> {
      const profile = await answer('get_provider_profile', { providerName: name, openingsLimit: 1 })
      return profile.providerId
    }

    function minutesOf(body: Json, key: string): number[] {
      return arr(body[key], key).map((o, i) =>
        num(expectOpening(o, `${key}[${String(i)}]`).minutes, 'minutes'),
      )
    }

    it('get_provider_openings: keeps only openings of at least minMinutes', async () => {
      // Bishop Arts Handyman's longest gap in [11-02, 11-05) is 90 minutes.
      const id = await providerId('Bishop Arts Handyman')
      const window = { providerId: id, from: '2026-11-02', to: '2026-11-05', limit: 50 }
      const sixty = minutesOf(
        await answer('get_provider_openings', { ...window, minMinutes: 60 }),
        'openings',
      )
      expect(sixty.length).toBeGreaterThan(0)
      sixty.forEach((m) => {
        expect(m).toBeGreaterThanOrEqual(60)
        expect(m).toBeLessThanOrEqual(90)
      })
      const twoHours = await answer('get_provider_openings', { ...window, minMinutes: 120 })
      expect(arr(twoHours.openings, 'openings')).toEqual([])
    })

    it('get_provider_openings: defaults minMinutes to 30', async () => {
      const id = await providerId('Bishop Arts Handyman')
      const body = await answer('get_provider_openings', {
        providerId: id,
        from: '2026-11-02',
        to: '2026-11-05',
        limit: 50,
      })
      expect(body.minMinutes).toBe(30)
      minutesOf(body, 'openings').forEach((m) => {
        expect(m).toBeGreaterThanOrEqual(30)
      })
    })

    it('get_provider_profile: minMinutes skips shorter next openings', async () => {
      const body = await answer('get_provider_profile', {
        providerName: 'Pecan Valley Plumbing',
        openingsLimit: 3,
        minMinutes: 360,
      })
      const openings = arr(body.nextOpenings, 'nextOpenings').map((o, i) =>
        expectOpening(o, `nextOpenings[${String(i)}]`),
      )
      expect(openings.map(span)).not.toContain(
        '2026-11-02T12:00:00-06:00/2026-11-02T17:00:00-06:00',
      )
      expect(openings[0] === undefined ? undefined : span(openings[0])).toBe(
        '2026-11-03T08:00:00-06:00/2026-11-03T17:00:00-06:00',
      )
      openings.forEach((opening) => {
        expect(num(opening.minutes, 'minutes')).toBeGreaterThanOrEqual(360)
      })
    })

    it.each([
      ['get_provider_openings', { from: '2026-11-02', to: '2026-11-05', minMinutes: 5000 }],
      ['get_provider_openings', { from: '2026-11-02', to: '2026-11-05', minMinutes: -15 }],
      ['get_provider_profile', { openingsLimit: 3, minMinutes: 5000 }],
      ['get_provider_profile', { openingsLimit: 3, minMinutes: -15 }],
    ] as const)('%s rejects out-of-range minMinutes %j naming the field', async (name, args) => {
      const id = await providerId('Pecan Valley Plumbing')
      const result = await mcp().call(name, { providerId: id, ...args })
      expect(result.isError).toBe(true)
      expect(result.raw).toMatch(/minMinutes/)
      expect(result.raw).toMatch(/\d+\s*(-|to)\s*\d+|at most \d+|at least \d+/)
    })
  })

  describe('traceability (R19)', () => {
    it('cites only existing fixture records in every tool answer', async () => {
      const bodies = await Promise.all([
        answer('search_job_history_near_address', {
          address: Q1_ADDRESS,
          radiusMiles: 0.5,
          lastMonths: 24,
          groupBy: 'trade',
        }),
        answer('get_scheduled_work_on_block', {
          street: 'Live Oak St',
          blockNumber: 4500,
          nextDays: 14,
        }),
        answer('get_provider_profile', { providerName: 'Pecan Valley Plumbing', openingsLimit: 3 }),
      ])
      const cited = bodies
        .flatMap((body) => collect(body, 'sources'))
        .flatMap(({ value }) => arr(value, 'sources'))
        .map((source) => obj(source, 'source') as unknown as Source)
      expect(cited.length).toBeGreaterThan(0)
      cited.forEach((source) => {
        expect(citationExists(source), JSON.stringify(source)).toBe(true)
      })
    })
  })
})
