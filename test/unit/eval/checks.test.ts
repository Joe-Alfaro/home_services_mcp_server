import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import {
  checkHouseNumbers,
  checkNoPii,
  checkResponseSize,
  checkSources,
  checkTimeOffsets,
  normalizeName,
  type Json,
  type JsonObject,
} from '../../../eval/checks/common.ts'
import type { Q1Expected } from '../../../eval/checks/q1.ts'
import type { Q2Expected } from '../../../eval/checks/q2.ts'
import type { Q3Expected } from '../../../eval/checks/q3.ts'
import type { Q4Expected } from '../../../eval/checks/q4.ts'
import type { Q5Expected } from '../../../eval/checks/q5.ts'
import {
  buildQuestions,
  loadExpected,
  Q1_MAX_RESPONSE_BYTES,
  type Question,
} from '../../../eval/questions.ts'

// Synthetic tool responses built from eval/expected: a well-formed answer must pass every check
// (common + question), and each known trap must fail it.

const questions = buildQuestions()
const SRC = [{ sourceSystem: 'workiz', sourceFile: 'jobs.json', sourceRecordId: 'ABC123' }]

function question(id: string): Question {
  const q = questions.find((x) => x.id === id)
  if (q === undefined) throw new Error(id)
  return q
}

function failuresOf(id: string, payload: Json): string[] {
  return question(id).check(payload).failures
}

function local(date: string, time: string): string {
  return DateTime.fromISO(`${date}T${time}`, { zone: 'America/Chicago' }).toISO() ?? ''
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function q1Answer(): JsonObject {
  const e = loadExpected('q1') as Q1Expected
  return {
    address: { block: '4500 block of Live Oak St', zip: '75204' },
    groups: Object.entries(e.trades).map(([trade, t]) => ({
      trade,
      count: t.count,
      sources: SRC,
    })),
  }
}

function q2Answer(): JsonObject {
  const e = loadExpected('q2') as Q2Expected
  return {
    window: { from: e.window.from, to: e.window.to },
    providers: e.providers.map((p) => ({
      name: p.name,
      sources: SRC,
      openings: p.referenceOpenings.map((o) => ({ ...o, confidence: 'medium', reasons: [] })),
    })),
  }
}

function q3Answer(): JsonObject {
  const e = loadExpected('q3') as Q3Expected
  return {
    block: { block: '4500 block of Live Oak St', zip: '75204' },
    items: e.rows.map((r) => ({
      providerName: r.provider,
      start: local(r.date, r.time),
      kind: r.kind,
      status: 'scheduled',
      property: { block: '4500 block of Live Oak St', zip: '75204' },
      sources: SRC,
    })),
  }
}

function q4Answer(): JsonObject {
  const e = loadExpected('q4') as Q4Expected
  return {
    name: 'Lone Star Plumbing Co.',
    sources: [
      { sourceSystem: 'profiles', sourceFile: 'providers.json', sourceRecordId: 'hp_009' },
      { sourceSystem: 'housecall_pro', sourceFile: 'company.json', sourceRecordId: 'com_1' },
      { sourceSystem: 'workiz', sourceFile: 'account.json', sourceRecordId: 'FDYR6V8B' },
    ],
    trades: ['plumbing'],
    serviceArea: {
      declared: e.declaredZips,
      observed: Object.entries(e.observedZips).map(([zip, count]) => ({
        zip,
        count,
        sources: SRC,
      })),
    },
    jobHistory: { completed: 262, scheduled: 182, cancelled: 35, limbo: 4, unscheduled: 13 },
    openings: e.referenceOpenings.map((o) => ({ ...o, confidence: 'medium' })),
  }
}

function q5Answer(): JsonObject {
  const e = loadExpected('q5') as Q5Expected
  return {
    address: '5823 Belmont Ave, Dallas, TX 75206',
    services: [
      ...e.services.map((s) => ({
        providerName: s.provider,
        start: local(s.date, '10:00'),
        status: 'completed',
        sources: SRC,
      })),
      {
        providerName: 'M Streets Handyman',
        start: '2026-06-02T10:00:00-05:00',
        status: 'cancelled',
        sources: SRC,
      },
    ],
  }
}

function q6Answer(): JsonObject {
  const order = [
    'Lone Star Plumbing',
    'Greenville Ave Plumbing',
    'Abrams Plumbing',
    'Tejas Rooter & Plumbing',
    'Dallas Drain Pros',
    'Rapid Rooter TX',
  ]
  return {
    ranking: order.map((name, i) => ({
      name,
      score: 100 - i * 10,
      confidence: 'medium',
      sources: SRC,
      factors: [
        {
          name: 'water_heater_history',
          detail: name === 'Dallas Drain Pros' ? 'no water-heater history' : 'replacements',
          sources: SRC,
        },
      ],
    })),
  }
}

describe('common checks', () => {
  it('requires the Chicago offset in force at each instant (R12 e)', () => {
    expect(checkTimeOffsets({ a: '2026-11-02T08:00:00-06:00' }).failures).toEqual([])
    expect(checkTimeOffsets({ a: '2026-10-31T09:00:00-05:00' }).failures).toEqual([])
    expect(checkTimeOffsets({ a: '2026-11-02T14:00:00Z' }).failures).toHaveLength(1)
    expect(checkTimeOffsets({ a: '2026-10-31T09:00:00-06:00' }).failures).toHaveLength(1)
    expect(checkTimeOffsets({ a: '2026-11-02T08:00:00' }).failures).toHaveLength(1)
  })

  it('checks every time field but leaves identifiers exactly as stored (R12 e, D-141)', () => {
    const icsId = 'evt-123@google.com@2026-10-20T18:15:00Z'
    const icsSource = { sourceSystem: 'ics', sourceFile: 'a.ics', sourceRecordId: icsId }
    expect(checkTimeOffsets({ jobs: [{ start: '2026-10-20T18:15:00Z' }] }).failures).toHaveLength(1)
    expect(
      checkTimeOffsets({ jobs: [{ start: '2026-10-20T18:15:00Z', sources: [icsSource] }] })
        .failures,
    ).toEqual([expect.stringContaining('$.jobs[0].start')])
    expect(
      checkTimeOffsets({ jobs: [{ start: '2026-10-20T13:15:00-05:00', sources: [icsSource] }] })
        .failures,
    ).toEqual([])
    expect(checkTimeOffsets({ jobId: icsId, blockIds: [icsId] }).failures).toEqual([])
    expect(checkTimeOffsets({ reasons: [`blocked by ${icsId}`] }).failures).toHaveLength(1)
  })

  it('flags phone- and email-shaped strings but not IDs or times (R17)', () => {
    expect(checkNoPii({ p: 'call (214) 555-0100' }).failures).toHaveLength(1)
    expect(checkNoPii({ p: '+1 214 555 0100' }).failures).toHaveLength(1)
    expect(checkNoPii({ p: '2145550100' }).failures).toHaveLength(1)
    expect(checkNoPii({ e: 'someone@example.com' }).failures).toHaveLength(1)
    const clean = {
      sources: [{ sourceSystem: 'ics', sourceFile: 'a.ics', sourceRecordId: 'abc123@google.com' }],
      t: '2026-11-02T08:00:00-06:00',
      id: 'hcp:job_2145550100abcdef',
      cents: 123450,
    }
    expect(checkNoPii(clean).failures).toEqual([])
  })

  it('allows hundred blocks and supplied numbers only (R17 c)', () => {
    expect(checkHouseNumbers({ a: '4500 block of Live Oak St' }, []).failures).toEqual([])
    expect(checkHouseNumbers({ a: '4512 Live Oak St' }, []).failures).toHaveLength(1)
    expect(checkHouseNumbers({ a: '4512 Live Oak St' }, ['4512']).failures).toEqual([])
    expect(checkHouseNumbers({ houseNumber: '1234' }, []).failures).toHaveLength(1)
    expect(checkHouseNumbers({ a: 'Replace water heater - gas 40G' }, []).failures).toEqual([])
  })

  it('requires sources on array items but not on openings (R19)', () => {
    expect(checkSources({ items: [{ a: 1, sources: SRC }] }).failures).toEqual([])
    expect(checkSources({ items: [{ a: 1 }] }).failures).toHaveLength(1)
    expect(checkSources({ items: [{ a: 1, sources: [{ sourceSystem: 'x' }] }] }).failures).toEqual(
      expect.arrayContaining([expect.stringContaining('malformed')]),
    )
    expect(checkSources({ openings: [{ start: 'x' }] }).failures).toEqual([])
    expect(checkSources({ name: 'x' }, { entity: true }).failures).toHaveLength(1)
  })

  it('exempts Q1 byTrade aggregates but still requires sources on samples and jobs (D-142)', () => {
    const byTrade = [
      { trade: 'plumbing', count: 3 },
      { trade: 'hvac', count: 1 },
    ]
    const sample = { date: '2026-10-01', trade: 'plumbing', sources: SRC }
    const ok = {
      total: 4,
      byTrade,
      groups: [{ trade: 'plumbing', count: 3, samples: [sample], sources: SRC }],
      jobs: [sample],
    }
    expect(checkSources(ok).failures).toEqual([])
    const bareSample = {
      ...ok,
      groups: [{ trade: 'plumbing', count: 3, samples: [{ date: '2026-10-01' }], sources: SRC }],
    }
    expect(checkSources(bareSample).failures).toEqual([
      expect.stringContaining('$.groups[0].samples[0]'),
    ])
    const bareJob = { ...ok, jobs: [{ date: '2026-10-01' }] }
    expect(checkSources(bareJob).failures).toEqual([expect.stringContaining('$.jobs[0]')])
  })

  it('compares business names ignoring case, punctuation and legal suffixes', () => {
    expect(normalizeName("Ray's Fix-It")).toBe(normalizeName('Rays Fix It'))
    expect(normalizeName('Lone Star Plumbing Co LLC')).toBe(normalizeName('Lone Star Plumbing'))
    expect(normalizeName('Lone Star Termite & Pest')).not.toBe(normalizeName('Lone Star Plumbing'))
  })
})

describe('Q1 search_job_history_near_address', () => {
  it('passes the expected per-trade counts', () => {
    expect(failuresOf('Q1', q1Answer())).toEqual([])
  })

  it('accepts a boundary record either way and the strict lower bound', () => {
    const a = q1Answer()
    const groups = a.groups as JsonObject[]
    groups.forEach((g) => {
      if (g.trade === 'hvac') g.count = 304
      if (g.trade === 'pest') g.count = 55
    })
    expect(failuresOf('Q1', a)).toEqual([])
  })

  it('accepts a different split of the two-trade provider', () => {
    const a = q1Answer()
    ;(a.groups as JsonObject[]).forEach((g) => {
      if (g.trade === 'handyman') g.count = 113
      if (g.trade === 'painting') g.count = 21
    })
    expect(failuresOf('Q1', a)).toEqual([])
  })

  it('fails visit-level counting, a dropped source and keyword re-mapping', () => {
    const visits = q1Answer()
    ;(visits.groups as JsonObject[]).forEach((g) => {
      if (g.trade === 'cleaning') g.count = 680
    })
    expect(failuresOf('Q1', visits)).toEqual([expect.stringContaining('cleaning')])

    const noCsv = q1Answer()
    ;(noCsv.groups as JsonObject[]).forEach((g) => {
      if (g.trade === 'handyman') g.count = 76
    })
    expect(failuresOf('Q1', noCsv).length).toBeGreaterThan(0)

    const remapped = q1Answer()
    ;(remapped.groups as JsonObject[]).push({ trade: 'water heater', count: 5, sources: SRC })
    expect(failuresOf('Q1', remapped)).toEqual([expect.stringContaining('water heater')])
  })
})

/** One paged item per expected Q1 job, citing its record (CSV rows get an implementation id). */
function q1Pages(): JsonObject[] {
  const e = loadExpected('q1') as Q1Expected
  return Object.entries(e.jobIds).flatMap(([trade, ids]) =>
    ids.map((id, i) => ({
      trade,
      block: '4500 block of Live Oak St',
      zip: '75204',
      sources: [
        {
          sourceSystem: id.slice(0, id.indexOf(':')),
          sourceFile: 'jobs.json',
          sourceRecordId: id.startsWith('csv:')
            ? `row:${String(i + 4)}`
            : id.slice(id.indexOf(':') + 1),
        },
      ],
    })),
  )
}

function q1PageFailures(items: JsonObject[], payload: Json = q1Answer()): string[] {
  const pages = question('Q1').pages
  if (pages === undefined) throw new Error('Q1 has no paged list')
  return pages.check(payload, items).failures
}

describe('Q1 summary mode: size budget and the paged job list (D-127)', () => {
  it('caps the default answer at 50 KB and pages the job list 100 at a time', () => {
    const q1 = question('Q1')
    expect(q1.maxResponseBytes).toBe(Q1_MAX_RESPONSE_BYTES)
    expect(Q1_MAX_RESPONSE_BYTES).toBe(50_000)
    expect(q1.args).not.toHaveProperty('limit')
    expect(q1.args).not.toHaveProperty('cursor')
    expect(q1.pages).toMatchObject({
      args: { ...q1.args, limit: 100 },
      itemsKey: 'jobs',
      cursorKey: 'nextCursor',
      cursorArg: 'cursor',
    })
  })

  it('checkResponseSize passes under the budget and fails at or over it', () => {
    expect(checkResponseSize(49_999, 50_000).failures).toEqual([])
    expect(checkResponseSize(49_999, 50_000).notes).toEqual([expect.stringContaining('KB')])
    expect(checkResponseSize(50_000, 50_000).failures).toEqual([
      expect.stringMatching(/50\.0 KB.*budget/),
    ])
    expect(checkResponseSize(113_509, 50_000).failures).toEqual([
      expect.stringContaining('113.5 KB'),
    ])
  })

  it('passes every expected job listed once with full recall', () => {
    const result = question('Q1').pages?.check(q1Answer(), q1Pages())
    expect(result?.failures).toEqual([])
    expect(result?.notes).toEqual(
      expect.arrayContaining([expect.stringMatching(/recall \(non-CSV\): 988\/988/)]),
    )
  })

  it('fails a missing job: count mismatch and recall below 100%', () => {
    const items = q1Pages()
    items.splice(0, 1)
    const failures = q1PageFailures(items)
    expect(failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('paged job list has 1006 jobs'),
        expect.stringMatching(/recall \(non-CSV\): 987\/988/),
      ]),
    )
  })

  it('fails a job listed twice in place of another', () => {
    const items = q1Pages()
    items[1] = structuredClone(items[0] as JsonObject)
    expect(q1PageFailures(items)).toEqual(
      expect.arrayContaining([expect.stringContaining('more than one paged item')]),
    )
  })

  it('fails a page whose trade tally disagrees with the summary counts', () => {
    const items = q1Pages()
    const first = items[0] as JsonObject
    first.trade = 'roofing'
    expect(q1PageFailures(items)).toEqual(
      expect.arrayContaining([expect.stringContaining('roofing jobs but the summary counts 7')]),
    )
  })

  it('applies the common checks to every paged job (R19, R17 c)', () => {
    const unsourced = q1Pages()
    delete (unsourced[5] as JsonObject).sources
    expect(q1PageFailures(unsourced)).toEqual(
      expect.arrayContaining([expect.stringContaining('R19 item without sources')]),
    )
    const house = q1Pages()
    ;(house[3] as JsonObject).address = '4518 Live Oak St'
    expect(q1PageFailures(house)).toEqual(
      expect.arrayContaining([expect.stringContaining('R17 house number')]),
    )
  })

  it('fails a summary total that is not the sum of the trade counts', () => {
    const a = q1Answer()
    a.total = 1006
    expect(failuresOf('Q1', a)).toEqual([expect.stringContaining('not the sum')])
  })
})

describe('Q2 find_providers', () => {
  it('passes the seven expected handymen with qualifying openings', () => {
    expect(failuresOf('Q2', q2Answer())).toEqual([])
  })

  it('fails when Uptown Odd Jobs is listed or a handyman is missing', () => {
    const extra = q2Answer()
    ;(extra.providers as JsonObject[]).push({ name: 'Uptown Odd Jobs', sources: SRC, openings: [] })
    expect(failuresOf('Q2', extra)).toEqual([expect.stringContaining('Uptown Odd Jobs')])

    const missing = q2Answer()
    ;(missing.providers as JsonObject[]).splice(0, 1)
    expect(failuresOf('Q2', missing)).toEqual([expect.stringContaining("Ray's Fix-It")])
  })

  it('fails when the rebranded account is listed separately', () => {
    const a = q2Answer()
    ;(a.providers as JsonObject[]).push(clone((a.providers as JsonObject[])[4] as JsonObject))
    ;((a.providers as JsonObject[])[7] as JsonObject).name = 'Big D Handyman'
    expect(failuresOf('Q2', a)).toEqual([expect.stringContaining('listed 2 times')])
  })

  it('fails an opening shorter than 2 h, without confidence, or over a busy block', () => {
    const short = q2Answer()
    const white = (short.providers as JsonObject[])[1] as JsonObject
    white.openings = [
      { start: '2026-11-02T12:30:00-06:00', end: '2026-11-02T14:00:00-06:00', confidence: 'high' },
    ]
    expect(failuresOf('Q2', short)).toEqual([expect.stringContaining('White Rock Handyman')])

    const noConf = q2Answer()
    const m = (noConf.providers as JsonObject[])[2] as JsonObject
    m.openings = [{ start: '2026-11-04T09:00:00-06:00', end: '2026-11-04T14:30:00-06:00' }]
    expect(failuresOf('Q2', noConf)).toEqual([expect.stringContaining('confidence')])

    const busy = q2Answer()
    const ray = (busy.providers as JsonObject[])[0] as JsonObject
    ray.openings = [
      { start: '2026-11-02T08:00:00-06:00', end: '2026-11-02T12:00:00-06:00', confidence: 'high' },
    ]
    expect(failuresOf('Q2', busy)).toEqual([expect.stringContaining('overlaps busy')])
  })
})

describe('Q3 get_scheduled_work_on_block', () => {
  it('passes the five expected items', () => {
    expect(failuresOf('Q3', q3Answer())).toEqual([])
  })

  it('fails a duplicated CSV job, an unlabelled estimate and the cancelled job', () => {
    const dup = q3Answer()
    ;(dup.items as JsonObject[]).push(clone((dup.items as JsonObject[])[0] as JsonObject))
    expect(failuresOf('Q3', dup)).toEqual([expect.stringContaining('listed 2 times')])

    const unlabelled = q3Answer()
    ;((unlabelled.items as JsonObject[])[4] as JsonObject).kind = 'job'
    expect(failuresOf('Q3', unlabelled)).toEqual([expect.stringContaining('estimate')])

    const cancelled = q3Answer()
    ;(cancelled.items as JsonObject[]).push({
      providerName: 'Clear Flow Gutters',
      start: '2026-11-05T09:00:00-06:00',
      kind: 'job',
      status: 'cancelled',
      sources: SRC,
    })
    expect(failuresOf('Q3', cancelled)).toEqual([expect.stringContaining('Clear Flow Gutters')])
  })

  it('fails when a house number leaks', () => {
    const a = q3Answer()
    ;((a.items as JsonObject[])[1] as JsonObject).address = '1234 Sample Ave'
    expect(failuresOf('Q3', a)).toEqual([expect.stringContaining('R17')])
  })
})

describe('Q4 get_provider_profile', () => {
  it('passes the merged provider with the capacity-model openings', () => {
    expect(failuresOf('Q4', q4Answer())).toEqual([])
  })

  it('fails history off by more than 1 and a merged-in Jobber account', () => {
    const counts = q4Answer()
    ;(counts.jobHistory as JsonObject).completed = 262 + 71
    expect(failuresOf('Q4', counts)).toEqual([expect.stringContaining('completed')])

    const merged = q4Answer()
    ;(merged.sources as JsonObject[]).push({
      sourceSystem: 'jobber',
      sourceFile: 'x.json',
      sourceRecordId: 'y',
    })
    expect(failuresOf('Q4', merged)).toEqual([expect.stringContaining('jobber')])
  })

  it('fails openings at full capacity, on Sunday or claiming high confidence on a free lane', () => {
    const full = q4Answer()
    full.openings = [
      {
        start: '2026-11-02T07:00:00-06:00',
        end: '2026-11-02T13:30:00-06:00',
        confidence: 'medium',
      },
      { start: '2026-11-02T13:30:00-06:00', end: '2026-11-02T14:30:00-06:00', confidence: 'low' },
      { start: '2026-11-02T14:30:00-06:00', end: '2026-11-02T15:30:00-06:00', confidence: 'low' },
    ]
    expect(failuresOf('Q4', full)).toEqual([expect.stringContaining('crew are booked')])

    const sunday = q4Answer()
    ;((sunday.openings as JsonObject[])[2] as JsonObject).start = '2026-11-08T09:00:00-06:00'
    ;((sunday.openings as JsonObject[])[2] as JsonObject).end = '2026-11-08T10:00:00-06:00'
    expect(failuresOf('Q4', sunday)).toEqual([expect.stringContaining('closed day')])

    const high = q4Answer()
    ;((high.openings as JsonObject[])[0] as JsonObject).confidence = 'high'
    expect(failuresOf('Q4', high)).toEqual([expect.stringContaining('D-041')])
  })
})

describe('Q5 get_property_service_history', () => {
  it('passes the five completed services with a labelled cancellation', () => {
    expect(failuresOf('Q5', q5Answer())).toEqual([])
  })

  it('fails the same house number on another street and an unlabelled cancellation', () => {
    const other = q5Answer()
    ;(other.services as JsonObject[]).push({
      providerName: 'Live Oak Electric',
      start: '2025-05-01T10:00:00-05:00',
      status: 'completed',
      sources: SRC,
    })
    expect(failuresOf('Q5', other)).toEqual([expect.stringContaining('Live Oak Electric')])

    const unlabelled = q5Answer()
    ;((unlabelled.services as JsonObject[])[5] as JsonObject).status = 'completed'
    expect(failuresOf('Q5', unlabelled)).toEqual([expect.stringContaining('cancelled')])
  })

  it('fails a missing service', () => {
    const a = q5Answer()
    ;(a.services as JsonObject[]).splice(1, 1)
    expect(failuresOf('Q5', a)).toEqual([expect.stringContaining('Frost Bros HVAC')])
  })
})

describe('Q6 rank_providers_for_job', () => {
  it('passes a complete, ordered, sourced ranking', () => {
    expect(failuresOf('Q6', q6Answer())).toEqual([])
  })

  it('fails when a plumber with no water-heater history ranks first', () => {
    const a = q6Answer()
    const ranking = a.ranking as JsonObject[]
    const drain = ranking.splice(4, 1)[0] as JsonObject
    ranking.unshift(drain)
    ranking.forEach((e, i) => {
      e.score = 100 - i * 10
    })
    const failures = failuresOf('Q6', a)
    expect(failures).toContain('Dallas Drain Pros must not rank first')
  })

  it('fails unsourced factors, unordered scores, an incomplete list and a non-plumber', () => {
    const unsourced = q6Answer()
    const first = (unsourced.ranking as JsonObject[])[0] as JsonObject
    first.factors = [{ name: 'distance' }]
    expect(failuresOf('Q6', unsourced)).toEqual(
      expect.arrayContaining([expect.stringContaining('cites no sources')]),
    )

    const unordered = q6Answer()
    ;((unordered.ranking as JsonObject[])[3] as JsonObject).score = 99
    expect(failuresOf('Q6', unordered)).toEqual([expect.stringContaining('not ordered by score')])

    const incomplete = q6Answer()
    ;(incomplete.ranking as JsonObject[]).splice(2, 1)
    expect(failuresOf('Q6', incomplete)).toEqual([expect.stringContaining('Abrams Plumbing')])

    const handyman = q6Answer()
    ;(handyman.ranking as JsonObject[]).push({
      name: 'M Streets Handyman',
      score: 1,
      confidence: 'low',
      sources: SRC,
      factors: [{ name: 'trade', sources: SRC }],
    })
    expect(failuresOf('Q6', handyman)).toEqual([expect.stringContaining('M Streets Handyman')])
  })
})
