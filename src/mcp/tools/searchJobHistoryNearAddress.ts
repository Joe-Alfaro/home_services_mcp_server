import { createHash } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { haversineMeters, type LatLon } from '../../normalize/geocode.ts'
import { resolveCallerAddress } from '../address.ts'
import type { ServerOptions } from '../context.ts'
import { loadJobs, type Job } from '../db.ts'
import { ToolInputError } from '../errors.ts'
import { presentJob } from '../present.ts'
import { mergeSources } from '../privacy.ts'
import { respond } from '../result.ts'
import { intField, localDateField, textField, tradeField } from '../schemas.ts'
import { lastMonthsWindow, presentWindow, windowInstants, type LocalWindow } from '../time.ts'

const METERS_PER_MILE = 1609.344
const MAX_RADIUS_MILES = 5

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100
const MAX_SAMPLES = 3

const DESCRIPTION = `Completed home-service work near a street address: per-trade counts, a few sample jobs per trade, and a paged list of the jobs.

Use when the question is "what work has been done near <address>" or "how many <trade> jobs within <distance> of <address>". Counts completed jobs only: estimates, cancelled and future work are excluded, and the visits of one recurring CRM job count as one job. Distance is straight-line between geocoded homes; addresses that cannot be placed on the street map are not counted.

Answer from "total" and the per-trade counts in "groups" (each with up to ${String(MAX_SAMPLES)} sample jobs and their sources). "jobs" is one page of the full job list (newest first within each trade, trades in the order of "groups"); page only if you need the individual jobs: call again with the same arguments plus cursor = the previous response's nextCursor, until nextCursor is null. limit sets the page size; trade restricts the paged list to one trade (the counts always cover every trade).

Do not use it for one home's own history (use get_property_service_history instead), for upcoming bookings on a block (use get_scheduled_work_on_block), or to pick a provider (use find_providers or rank_providers_for_job).

Parameters: address (street address with number, street and 5-digit zip), radiusMiles (0 < r <= 5), lastMonths (1-60) or since/until (YYYY-MM-DD, until exclusive), groupBy ("trade"), limit (1-${String(MAX_LIMIT)} jobs per page, default ${String(DEFAULT_LIMIT)}), cursor (nextCursor from the previous page), trade (optional, filters the paged list).
Privacy: homes are shown as "4500 block of Live Oak St" + zip; only the house number you supplied is echoed.

Example: {"address": "4512 Live Oak St, Dallas, TX 75204", "radiusMiles": 0.5, "lastMonths": 24, "groupBy": "trade"}`

export const searchJobHistoryInput = {
  address: textField('address', 200, '4512 Live Oak St, Dallas, TX 75204').describe(
    'Street address to search around: house number, street, city, state and 5-digit zip, e.g. "4512 Live Oak St, Dallas, TX 75204".',
  ),
  radiusMiles: z
    .number({
      error: `radiusMiles must be a number of miles greater than 0 and at most ${String(MAX_RADIUS_MILES)}`,
    })
    .gt(0, `radiusMiles must be greater than 0 and at most ${String(MAX_RADIUS_MILES)} miles`)
    .max(
      MAX_RADIUS_MILES,
      `radiusMiles must be at most ${String(MAX_RADIUS_MILES)} miles (accepted: > 0 to 5)`,
    )
    .default(0.5)
    .describe(
      'Search radius in miles, greater than 0 and at most 5 (half a mile = 0.5). Default 0.5.',
    ),
  lastMonths: intField('lastMonths', 1, 60, 'months')
    .optional()
    .describe(
      'Look back this many months from today (window [today - N months, today)). Default 24 when since/until are not given.',
    ),
  since: localDateField(
    'since',
    'Window start, local date YYYY-MM-DD (inclusive). Use instead of lastMonths.',
  )
    .optional()
    .describe('Window start, local date YYYY-MM-DD (inclusive). Use instead of lastMonths.'),
  until: localDateField(
    'until',
    'Window end, local date YYYY-MM-DD (exclusive). Defaults to today.',
  )
    .optional()
    .describe('Window end, local date YYYY-MM-DD (exclusive). Defaults to today.'),
  groupBy: z
    .enum(['trade'], { error: 'groupBy must be "trade"' })
    .default('trade')
    .describe('How to group the results; only "trade" is supported.'),
  limit: intField('limit', 1, MAX_LIMIT, 'jobs')
    .default(DEFAULT_LIMIT)
    .describe(
      `Jobs per page of the "jobs" list, 1-${String(MAX_LIMIT)}. Default ${String(DEFAULT_LIMIT)}. The per-trade counts never depend on it.`,
    ),
  cursor: z
    .string({ error: 'cursor must be the nextCursor string of the previous response' })
    .max(200, 'cursor must be the nextCursor string of the previous response, unchanged')
    .optional()
    .describe(
      "Opaque page token: pass the previous response's nextCursor unchanged, with the other arguments repeated as they were. Omit it for the first page.",
    ),
  trade: tradeField
    .optional()
    .describe(
      'Only page through jobs of this trade. The per-trade counts still cover every trade.',
    ),
}

type Input = z.infer<z.ZodObject<typeof searchJobHistoryInput>>

function chooseWindow(input: Input, today: string): LocalWindow {
  if (input.since === undefined && input.until === undefined) {
    return lastMonthsWindow(today, input.lastMonths ?? 24)
  }
  if (input.lastMonths !== undefined) {
    throw new ToolInputError('lastMonths', 'give either lastMonths or since/until, not both')
  }
  const to = input.until ?? today
  const from = input.since ?? lastMonthsWindow(to, 24).from
  if (from >= to) {
    throw new ToolInputError('since', `must be before until (${to}); dates are YYYY-MM-DD`)
  }
  return { from, to }
}

/** When a service was done: its end, else its completion, else its start. */
function doneAt(job: Job): Date | null {
  return job.endAt ?? job.completedAt ?? job.startAt
}

function boundingBox(origin: LatLon, meters: number) {
  const dLat = meters / 111_320
  const dLon = meters / (111_320 * Math.cos((origin.lat * Math.PI) / 180))
  return [origin.lat - dLat, origin.lat + dLat, origin.lon - dLon, origin.lon + dLon]
}

/** Ties a cursor to the arguments that define the job list, so it can't page another query. */
function queryKey(input: Input, window: LocalWindow): string {
  const key = [input.address, input.radiusMiles, window.from, window.to, input.trade ?? '*']
  return createHash('sha256').update(JSON.stringify(key)).digest('base64url').slice(0, 16)
}

function encodeCursor(offset: number, key: string): string {
  return Buffer.from(JSON.stringify({ o: offset, k: key })).toString('base64url')
}

const BAD_CURSOR =
  "not a cursor issued for these arguments; pass the previous response's nextCursor unchanged and repeat the other arguments exactly, or omit cursor to start from the first page"

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** The offset a cursor points at; a cursor from another query or a made-up one is rejected. */
function decodeCursor(cursor: string, key: string): number {
  const parsed = parseJson(Buffer.from(cursor, 'base64url').toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null) throw new ToolInputError('cursor', BAD_CURSOR)
  const { o, k } = parsed as { o?: unknown; k?: unknown }
  if (k !== key || typeof o !== 'number' || !Number.isInteger(o) || o < 0) {
    throw new ToolInputError('cursor', BAD_CURSOR)
  }
  return o
}

export async function searchJobHistoryNearAddress(input: Input, options: ServerOptions) {
  const window = chooseWindow(input, options.today)
  const key = queryKey(input, window)
  const offset = input.cursor === undefined ? 0 : decodeCursor(input.cursor, key)
  const caller = await resolveCallerAddress(options.pool, input.address)
  const houseNumber = caller.normalized.houseNumber
  let origin = caller.point
  if (origin === null) {
    // The street map can't place it (e.g. a number past the reference range); a stored home with
    // the same address key still has coordinates.
    const { rows } = await options.pool.query<{ lat: number; lon: number }>(
      'SELECT lat, lon FROM v_properties WHERE address_key_hash = $1 AND lat IS NOT NULL LIMIT 1',
      [caller.keyHash],
    )
    origin = rows[0] ?? null
  }
  if (origin === null) {
    throw new ToolInputError(
      'address',
      `could not place "${input.address}" on the reference street map (${caller.geocodeReason ?? 'unknown street'}); give house number, street and 5-digit zip inside the service area, e.g. "4512 Live Oak St, Dallas, TX 75204"`,
    )
  }

  // Rounded to 0.1 m: the requirements state half a mile as 804.7 m (Q1 interpretation).
  const radiusMeters = Math.round(input.radiusMiles * METERS_PER_MILE * 10) / 10
  const instants = windowInstants(window)
  const [minLat, maxLat, minLon, maxLon] = boundingBox(origin, radiusMeters)
  const candidates = await loadJobs(
    options.pool,
    `j.status = 'completed' AND j.kind <> 'estimate' AND j.lat IS NOT NULL
       AND coalesce(j.end_at, j.completed_at, j.start_at) >= $1
       AND coalesce(j.end_at, j.completed_at, j.start_at) < $2
       AND j.lat BETWEEN $3 AND $4 AND j.lon BETWEEN $5 AND $6`,
    [instants.from, instants.to, minLat, maxLat, minLon, maxLon],
  )
  const point = origin
  const nearby = candidates
    .map((job) => ({
      job,
      meters: haversineMeters(point, { lat: job.lat ?? 0, lon: job.lon ?? 0 }),
    }))
    .filter(({ meters }) => meters <= radiusMeters)

  // One entry per service: CRM A visits of one job collapse to that job (Q1).
  const services = [
    ...nearby
      .reduce((map, entry) => {
        map.set(entry.job.serviceKey, [...(map.get(entry.job.serviceKey) ?? []), entry])
        return map
      }, new Map<string, { job: Job; meters: number }[]>())
      .values(),
  ].map((entries) => {
    const ordered = [...entries].sort(
      (a, b) => (doneAt(a.job)?.getTime() ?? 0) - (doneAt(b.job)?.getTime() ?? 0),
    )
    const last = ordered.at(-1) ?? entries[0]
    if (last === undefined) throw new Error('empty service group')
    const first = ordered[0] ?? last
    const presented = presentJob(last.job, houseNumber === null ? [] : [houseNumber])
    const trade = last.job.trade ?? 'unclassified'
    return {
      trade,
      serviceKey: last.job.serviceKey,
      // The record the count stands for: a visit group's parent job, else the job itself.
      counted: (last.job.parentSources.length > 0
        ? last.job.parentSources
        : last.job.sources
      ).slice(0, 1),
      lastDone: doneAt(last.job)?.getTime() ?? 0,
      item: {
        ...presented,
        trade,
        start: presentJob(first.job).start,
        ...(entries.length > 1 ? { visits: entries.length } : {}),
        distanceMiles: Math.round((last.meters / METERS_PER_MILE) * 100) / 100,
        sources: mergeSources(
          // Q1 counts jobs, so a visit group also cites its parent CRM job's own record (R19).
          last.job.parentSources,
          ...entries.map((entry) => entry.job.sources),
        ),
      },
    }
  })

  const groups = [
    ...services
      .reduce((map, service) => {
        map.set(service.trade, [...(map.get(service.trade) ?? []), service])
        return map
      }, new Map<string, typeof services>())
      .entries(),
  ]
    .map(([trade, list]) => ({
      trade,
      // Newest first; the service key breaks ties so every page sees the same order.
      jobs: [...list].sort(
        (a, b) => b.lastDone - a.lastDone || a.serviceKey.localeCompare(b.serviceKey),
      ),
    }))
    .sort((a, b) => b.jobs.length - a.jobs.length || a.trade.localeCompare(b.trade))

  // Q1 summary mode: the counts answer the question; the job list comes one page at a time.
  const listed = groups
    .filter((group) => input.trade === undefined || group.trade === input.trade)
    .flatMap((group) => group.jobs.map((service) => service.item))
  const page = listed.slice(offset, offset + input.limit)
  const next = offset + page.length
  const total = groups.reduce((sum, group) => sum + group.jobs.length, 0)

  return {
    query: {
      address: input.address,
      block: caller.normalized.blockLabel,
      zip: caller.normalized.zip,
      radiusMiles: input.radiusMiles,
      window: { ...presentWindow(window), fromDate: window.from, toDateExclusive: window.to },
      groupBy: input.groupBy,
      ...(input.trade === undefined ? {} : { trade: input.trade }),
    },
    total,
    groups: groups.map((group) => {
      const sampleJobs = group.jobs.slice(0, MAX_SAMPLES)
      return {
        trade: group.trade,
        count: group.jobs.length,
        sampleJobs: sampleJobs.map((service) => service.item),
        // One citation per sample, the record it counts; the samples carry the rest. Every
        // job's sources would defeat the summary on a busy address (D-132).
        sources: mergeSources(...sampleJobs.map((service) => service.counted)),
      }
    }),
    jobs: page,
    page: { offset, limit: input.limit, returned: page.length, of: listed.length },
    nextCursor: next < listed.length ? encodeCursor(next, key) : null,
    notes: [
      'Counts completed jobs whose end falls in the window; estimates, cancelled and future work are excluded.',
      'Visits of one recurring CRM job count once (see "visits").',
      'Distance is straight-line between interpolated home locations.',
      'Answer from total and groups[].count; page "jobs" with nextCursor only if the individual jobs are needed.',
    ],
  }
}

export function registerSearchJobHistoryNearAddress(
  server: McpServer,
  options: ServerOptions,
): void {
  server.registerTool(
    'search_job_history_near_address',
    {
      title: 'Job history near an address',
      description: DESCRIPTION,
      inputSchema: searchJobHistoryInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      respond('search_job_history_near_address', () => searchJobHistoryNearAddress(args, options)),
  )
}
