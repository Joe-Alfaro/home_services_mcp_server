import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { citationExists, Q1_PACK_DIR, type Source } from './support/pack.ts'
import {
  arr,
  num,
  obj,
  startMcpHarness,
  str,
  type Json,
  type McpHarness,
  type ToolCall,
} from './support/mcp.ts'

/*
 * Q1 summary mode (Q1, R15, R18, R19) on test/fixtures/q1_pack, an invented pack with enough nearby
 * work that the full job list would be far too big for a live agent. The main pack's hand-computed
 * answers are untouched (mcpTools.test.ts).
 *
 * The pack (every home on Live Oak St 75204; 4400-4699 lie within ~450 m of 4512):
 *   six CRM C (Workiz) providers, one trade each; jobs <PREFIX>001..<PREFIX>0NN are completed
 *   in [2025-01-06, 2026-10-28] at 4400-4699 and are counted:
 *     Quarry Hill Air       hvac        QH001-QH050  (50)
 *     Thistle Bend Plumbing plumbing    TB001-TB040  (40)
 *     Wren Meadow Cleaning  cleaning    WM001-WM030  (30)
 *     Vesper Spark Electric electrical  VS001-VS025  (25)
 *     Oxbow Pest Works      pest        OB001-OB020  (20)
 *     Larch Point Painting  painting    LP001-LP015  (15)
 *   and four excluded jobs each (<PREFIX>X01 cancelled, X02 completed 2024-06-10 before the
 *   window, X03 completed at 4990 Live Oak St ~1.1 km away, X04 scheduled 2026-11-20);
 *   Bramble Lawn Care (lawn, CRM A): job-q1lawn-01 and job-q1lawn-02, each with 12 completed
 *   visits (visit-q1lawn-0N-01..12) → 2 services.
 *   Answer for 4512 Live Oak St, 0.5 mi, 24 months: total 182; hvac 50, plumbing 40, cleaning 30,
 *   electrical 25, pest 20, painting 15, lawn 2.
 *
 * Pinned contract (extra fields are fine):
 *   input   + limit (integer, default 10-50, 100 accepted, 0 and 500 rejected naming "limit"),
 *             cursor (the previous response's nextCursor; the other arguments are repeated
 *             unchanged), trade (optional trade enum; filters only the paged job list)
 *   output  { total, groups: [{ trade, count, sampleJobs: Job[1..3], sources }],
 *             jobs: Job[] (one page), nextCursor: string | null }
 *           Job = { trade, provider, block, zip, sources, ... }; a visit group is one Job citing
 *           its parent job and its visits.
 *   The default response (no limit, no cursor) is under 30 KB on this pack; groups always carry
 *   every trade's count, also when a cursor or trade filter is given. Following nextCursor until
 *   it is null returns every counted job exactly once.
 */

const ARGS = {
  address: '4512 Live Oak St, Dallas, TX 75204',
  radiusMiles: 0.5,
  lastMonths: 24,
  groupBy: 'trade',
}
const DEFAULT_BUDGET_BYTES = 30_000
const MAX_SAMPLES = 3

interface PackProvider {
  prefix: string
  trade: string
  jobs: number
}

const WORKIZ: PackProvider[] = [
  { prefix: 'QH', trade: 'hvac', jobs: 50 },
  { prefix: 'TB', trade: 'plumbing', jobs: 40 },
  { prefix: 'WM', trade: 'cleaning', jobs: 30 },
  { prefix: 'VS', trade: 'electrical', jobs: 25 },
  { prefix: 'OB', trade: 'pest', jobs: 20 },
  { prefix: 'LP', trade: 'painting', jobs: 15 },
]
const LAWN_JOBS = ['job-q1lawn-01', 'job-q1lawn-02']
const COUNTS = {
  hvac: 50,
  plumbing: 40,
  cleaning: 30,
  electrical: 25,
  pest: 20,
  painting: 15,
  lawn: 2,
}
const TOTAL = 182

function workizIds(provider: PackProvider): string[] {
  return Array.from(
    { length: provider.jobs },
    (_, i) => `${provider.prefix}${String(i + 1).padStart(3, '0')}`,
  )
}

/** Counted record id → trade: every Workiz job of the pack plus the two lawn parent jobs. */
const COUNTED = new Map<string, string>([
  ...WORKIZ.flatMap((p) => workizIds(p).map((id): [string, string] => [id, p.trade])),
  ...LAWN_JOBS.map((id): [string, string] => [id, 'lawn']),
])
const EXCLUDED = WORKIZ.flatMap((p) => ['X01', 'X02', 'X03', 'X04'].map((x) => `${p.prefix}${x}`))

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

/** The counted records a job cites (exactly one per job). */
function countedIdsOf(job: unknown, what: string): string[] {
  return sourcesOf(job, what)
    .map((source) => source.sourceRecordId)
    .filter((id) => COUNTED.has(id))
}

function jobsOf(body: Json, what: string): Json[] {
  return arr(body.jobs, `${what}.jobs`).map((job, i) => obj(job, `${what}.jobs[${String(i)}]`))
}

function cursorOf(body: Json, what: string): string | null {
  const next = body.nextCursor
  if (next === null) return null
  return str(next, `${what}.nextCursor`)
}

function countsOf(body: Json): Record<string, number> {
  return Object.fromEntries(
    arr(body.groups, 'groups').map((group, i) => {
      const g = obj(group, `groups[${String(i)}]`)
      return [str(g.trade, 'trade'), num(g.count, 'count')]
    }),
  )
}

describe('Q1 summary mode on the paging pack', () => {
  let harness: McpHarness | undefined

  function mcp(): McpHarness {
    if (harness === undefined) throw new Error('MCP harness did not start')
    return harness
  }

  async function call(args: Record<string, unknown>): Promise<{ call: ToolCall; body: Json }> {
    const result = await mcp().call('search_job_history_near_address', args)
    expect(result.isError, `search_job_history_near_address failed: ${result.raw}`).toBe(false)
    return { call: result, body: obj(result.body, 'body') }
  }

  /** Follows nextCursor from the first page to the end; fails after 50 pages. */
  async function allPages(args: Record<string, unknown>): Promise<Json[]> {
    const pages: Json[] = []
    let cursor: string | null | undefined
    while (cursor !== null) {
      if (pages.length >= 50) throw new Error('nextCursor never became null')
      const { body } = await call(cursor === undefined ? args : { ...args, cursor })
      pages.push(body)
      cursor = cursorOf(body, `page ${String(pages.length)}`)
    }
    return pages
  }

  beforeAll(async () => {
    harness = await startMcpHarness(Q1_PACK_DIR)
  })

  afterAll(async () => {
    await harness?.close()
  })

  describe('the default response is a small summary', () => {
    let first: { call: ToolCall; body: Json }

    beforeAll(async () => {
      first = await call(ARGS)
    })

    it('Q1: answers with per-trade counts and the total', () => {
      expect(countsOf(first.body)).toEqual(COUNTS)
      expect(first.body.total).toBe(TOTAL)
    })

    it(`Q1, R18: the default response is under ${String(DEFAULT_BUDGET_BYTES / 1000)} KB`, () => {
      const bytes = Buffer.byteLength(first.call.raw, 'utf8')
      expect(bytes).toBeLessThan(DEFAULT_BUDGET_BYTES)
    })

    it(`Q1, R19: each trade shows 1-${String(MAX_SAMPLES)} sample jobs of that trade, with sources`, () => {
      arr(first.body.groups, 'groups').forEach((value, i) => {
        const group = obj(value, `groups[${String(i)}]`)
        const trade = str(group.trade, 'trade')
        const count = num(group.count, 'count')
        sourcesOf(group, `groups[${String(i)}]`)
        const samples = arr(group.sampleJobs, `${trade}.sampleJobs`)
        expect(samples.length, trade).toBeGreaterThanOrEqual(1)
        expect(samples.length, trade).toBeLessThanOrEqual(Math.min(MAX_SAMPLES, count))
        samples.forEach((sample, j) => {
          const what = `${trade}.sampleJobs[${String(j)}]`
          expect(obj(sample, what).trade, what).toBe(trade)
          const counted = countedIdsOf(sample, what)
          expect(counted, what).toHaveLength(1)
          expect(COUNTED.get(counted[0] ?? ''), what).toBe(trade)
        })
      })
    })

    it('Q1: no group carries its full job list', () => {
      arr(first.body.groups, 'groups').forEach((value, i) => {
        const group = obj(value, `groups[${String(i)}]`)
        Object.entries(group)
          .filter(([key, inner]) => key !== 'sources' && Array.isArray(inner))
          .forEach(([key, inner]) => {
            expect((inner as unknown[]).length, `groups[${String(i)}].${key}`).toBeLessThanOrEqual(
              MAX_SAMPLES,
            )
          })
      })
    })

    it('Q1: returns the first page of the job list with a bounded default size and a cursor', () => {
      const jobs = jobsOf(first.body, 'default')
      expect(jobs.length).toBeGreaterThanOrEqual(10)
      expect(jobs.length).toBeLessThanOrEqual(50)
      expect(typeof first.body.nextCursor).toBe('string')
      jobs.forEach((job, i) => {
        const what = `jobs[${String(i)}]`
        expect(Object.keys(COUNTS), what).toContain(job.trade)
        expect(String(job.block), what).toMatch(/^\d+00 block of Live Oak St$/)
        expect(job.zip, what).toBe('75204')
        expect(countedIdsOf(job, what), what).toHaveLength(1)
      })
    })
  })

  describe('following nextCursor', () => {
    let pages: Json[]
    let jobs: Json[]

    beforeAll(async () => {
      pages = await allPages({ ...ARGS, limit: 40 })
      jobs = pages.flatMap((page, i) => jobsOf(page, `page ${String(i + 1)}`))
    })

    it('Q1: pages of at most `limit` jobs, ending with nextCursor null', () => {
      expect(pages.map((page) => jobsOf(page, 'page').length)).toEqual([40, 40, 40, 40, 22])
      expect(pages.at(-1)?.nextCursor).toBeNull()
      pages.slice(0, -1).forEach((page, i) => {
        expect(typeof page.nextCursor, `page ${String(i + 1)}`).toBe('string')
      })
    })

    it('Q1: every page keeps the full per-trade counts', () => {
      pages.forEach((page) => {
        expect(countsOf(page)).toEqual(COUNTS)
        expect(page.total).toBe(TOTAL)
      })
    })

    it('Q1, R19: returns every counted job exactly once, nothing excluded', () => {
      expect(jobs).toHaveLength(TOTAL)
      const cited = jobs.flatMap((job, i) => countedIdsOf(job, `jobs[${String(i)}]`))
      const seen = cited.reduce(
        (map, id) => map.set(id, (map.get(id) ?? 0) + 1),
        new Map<string, number>(),
      )
      expect([...seen.entries()].filter(([, n]) => n !== 1)).toEqual([])
      expect([...seen.keys()].sort()).toEqual([...COUNTED.keys()].sort())
      const all = jobs.flatMap((job, i) =>
        sourcesOf(job, `jobs[${String(i)}]`).map((s) => s.sourceRecordId),
      )
      EXCLUDED.forEach((id) => {
        expect(all, id).not.toContain(id)
      })
    })

    it('Q1: each job sits under its own trade', () => {
      jobs.forEach((job, i) => {
        const [id] = countedIdsOf(job, `jobs[${String(i)}]`)
        expect(job.trade, id).toBe(COUNTED.get(id ?? ''))
      })
    })

    it('Q1, R19: a visit group is one job citing its parent and all 12 visits', () => {
      LAWN_JOBS.forEach((parent) => {
        const matching = jobs.filter((job) =>
          sourcesOf(job, parent).some((s) => s.sourceRecordId === parent),
        )
        expect(matching, parent).toHaveLength(1)
        const visits = sourcesOf(matching[0], parent)
          .map((s) => s.sourceRecordId)
          .filter((id) => id.startsWith(parent.replace('job-', 'visit-')))
        expect(new Set(visits).size, parent).toBe(12)
      })
    })

    it('R19 b: every citation exists in the cited fixture file', () => {
      jobs
        .flatMap((job, i) => sourcesOf(job, `jobs[${String(i)}]`))
        .forEach((source) => {
          expect(citationExists(source, Q1_PACK_DIR), JSON.stringify(source)).toBe(true)
        })
    })
  })

  describe('trade filter for the paged list', () => {
    it('Q1: pages through one trade only, while the summary keeps every trade', async () => {
      const pages = await allPages({ ...ARGS, trade: 'pest', limit: 7 })
      expect(pages.map((page) => jobsOf(page, 'page').length)).toEqual([7, 7, 6])
      pages.forEach((page) => {
        expect(countsOf(page)).toEqual(COUNTS)
      })
      const jobs = pages.flatMap((page) => jobsOf(page, 'page'))
      jobs.forEach((job) => {
        expect(job.trade).toBe('pest')
      })
      const cited = jobs.flatMap((job, i) => countedIdsOf(job, `pest[${String(i)}]`)).sort()
      expect(cited).toEqual(workizIds({ prefix: 'OB', trade: 'pest', jobs: 20 }))
    })
  })

  describe('limit and cursor input errors (R18 c)', () => {
    it('Q1: accepts limit 100', async () => {
      const { body } = await call({ ...ARGS, limit: 100 })
      expect(jobsOf(body, 'limit 100')).toHaveLength(100)
    })

    it.each([0, 500, 2.5])('Q1, R18 c: rejects limit %s naming the field', async (limit) => {
      const result = await mcp().call('search_job_history_near_address', { ...ARGS, limit })
      expect(result.isError).toBe(true)
      expect(result.raw).toMatch(/\blimit\b/)
      expect(result.raw).toMatch(/\d+\s*(-|to)\s*\d+|at most \d+|at least \d+/)
    })

    it('Q1, R18 c: rejects a cursor it did not issue, naming the field', async () => {
      const result = await mcp().call('search_job_history_near_address', {
        ...ARGS,
        cursor: 'not-a-cursor',
      })
      expect(result.isError).toBe(true)
      expect(result.raw).toMatch(/\bcursor\b/)
      expect(result.raw).toMatch(/nextCursor/)
    })
  })

  /*
   * Q1 counts first (pinned shape). The per-trade counts are the primary answer, so they come
   * first as a compact section and the samples follow in a separate one:
   *   { query, total, byTrade: [{ trade, count }], groups: [{ trade, count, sampleJobs, sources }],
   *     jobs, page, nextCursor, notes }
   * byTrade has one entry per trade with exactly the keys trade and count, in the order of groups,
   * on every page (also with a cursor or a trade filter). In the response text, "byTrade" and all
   * of its counts come before "groups", before the first "sampleJobs" and before "jobs", and end
   * within the first BY_TRADE_WITHIN_BYTES bytes.
   */
  describe('Q1: per-trade counts come first, samples separately', () => {
    const BY_TRADE_WITHIN_BYTES = 1_500

    function byTradeOf(body: Json): { trade: string; count: number }[] {
      return arr(body.byTrade, 'byTrade').map((value, i) => {
        const entry = obj(value, `byTrade[${String(i)}]`)
        expect(Object.keys(entry).sort(), `byTrade[${String(i)}] keys`).toEqual(['count', 'trade'])
        return { trade: str(entry.trade, 'trade'), count: num(entry.count, 'count') }
      })
    }

    it('Q1: byTrade lists every trade once with its count, in the order of groups, summing to total', async () => {
      const { body } = await call(ARGS)
      const byTrade = byTradeOf(body)
      expect(Object.fromEntries(byTrade.map((e) => [e.trade, e.count]))).toEqual(COUNTS)
      expect(byTrade.map((e) => e.trade)).toEqual(
        arr(body.groups, 'groups').map((g) => obj(g, 'group').trade),
      )
      expect(byTrade.reduce((sum, e) => sum + e.count, 0)).toBe(TOTAL)
      expect(body.total).toBe(TOTAL)
    })

    it('Q1: the counts section precedes groups, every sample and the job list in the response text', async () => {
      const { call: result } = await call(ARGS)
      const text = result.raw
      const at = text.indexOf('"byTrade"')
      expect(at, 'byTrade present').toBeGreaterThanOrEqual(0)
      const section = text.indexOf(']', at)
      expect(section, 'end of byTrade').toBeGreaterThan(at)
      expect(section).toBeLessThan(text.indexOf('"groups"'))
      expect(section).toBeLessThan(text.indexOf('"sampleJobs"'))
      expect(section).toBeLessThan(text.indexOf('"jobs"'))
      expect(section).toBeLessThan(BY_TRADE_WITHIN_BYTES)
    })

    it('Q1: every page, also with a trade filter, repeats byTrade for every trade', async () => {
      const pages = [
        ...(await allPages({ ...ARGS, limit: 100 })),
        ...(await allPages({ ...ARGS, trade: 'lawn' })),
      ]
      pages.forEach((page) => {
        expect(Object.fromEntries(byTradeOf(page).map((e) => [e.trade, e.count]))).toEqual(COUNTS)
      })
    })
  })
})
