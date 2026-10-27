import { DateTime } from 'luxon'
import type pg from 'pg'
import type { Confidence } from '../availability/confidence.ts'
import {
  computeAvailability,
  type AvailabilityResult,
  type BusyItem,
  type BusyStatus,
  type HistoryItem,
  type Opening,
  type WeeklyHours,
} from '../availability/engine.ts'
import { TIME_ZONE } from '../config.ts'
import { mergeSources, readSources, type Source } from './privacy.ts'
import { localizeInstants, presentInstant } from './time.ts'

/*
 * Glue between the read views and the availability engine (R13, D-041): declared hours from
 * v_declared_hours, booked work from v_jobs and calendar blocks from v_calendar_blocks. The engine
 * does the arithmetic; this file only maps rows.
 */

export interface ProviderAvailability {
  providerId: string
  result: AvailabilityResult
  /** Citations of the declared hours, per ISO weekday. */
  hoursSources: Map<number, Source[]>
}

/** An opening as the tools present it (R12 e, R13). */
export interface PresentedOpening {
  start: string
  end: string
  minutes: number
  confidence: Confidence
  reasons: string[]
  sources?: Source[]
}

const WORK_KINDS = new Set(['job', 'visit', 'estimate'])

interface HoursRow {
  provider_id: string
  weekday: number
  start_local: string
  end_local: string
  always_open: boolean
  sources: unknown
}

interface WorkRow {
  id: string
  provider_id: string
  kind: 'job' | 'visit' | 'estimate'
  status: BusyStatus
  start_at: Date | null
  end_at: Date | null
  all_day: boolean
  rescheduled_from: string | null
  source_systems: string[]
  sources: unknown
}

interface BlockRow {
  provider_id: string
  start_at: Date
  end_at: Date
  all_day: boolean
  busy: boolean
  category: 'work' | 'personal' | 'unknown'
  mirrored_job_id: string | null
  /** G17: a tentative hold still blocks, at low confidence; a cancelled one never does. */
  status: 'confirmed' | 'tentative' | 'cancelled'
  sources: unknown
}

function isWeekday(value: number): value is WeeklyHours['weekday'] {
  return Number.isInteger(value) && value >= 1 && value <= 7
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString()
}

/** A CSV-only booking is a single uncorroborated row: it blocks, but cautiously (D-041). */
function workConfidence(row: WorkRow): Confidence {
  return row.source_systems.length === 1 && row.source_systems[0] === 'spreadsheet'
    ? 'medium'
    : 'high'
}

function earliest(a: Date | null, b: Date): Date {
  return a === null || b < a ? b : a
}

function latest(a: Date | null, b: Date): Date {
  return a === null || b > a ? b : a
}

/**
 * A booking as one busy item. When a calendar event mirrors it (D-047), the booking spans both:
 * a CSV row often has no end while its calendar event has the real one (cautious answer, R13).
 */
function workBusy(row: WorkRow, mirrors: readonly BlockRow[]): BusyItem {
  const startAt = mirrors.reduce((at, block) => earliest(at, block.start_at), row.start_at)
  const endAt = mirrors.reduce((at, block) => latest(at, block.end_at), row.end_at)
  return {
    kind: row.kind,
    status: row.status,
    startAt: iso(startAt),
    endAt: iso(endAt),
    allDay: row.all_day,
    busy: true,
    confidence: workConfidence(row),
    sources: mergeSources(readSources(row.sources), ...mirrors.map((m) => readSources(m.sources))),
    category: 'work',
    rescheduledFrom: row.rescheduled_from,
  }
}

function blockBusy(row: BlockRow): BusyItem {
  return {
    kind: 'calendar_block',
    status: row.status,
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
    allDay: row.all_day,
    busy: row.busy,
    confidence: 'high',
    sources: readSources(row.sources),
    category: row.category,
  }
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  return rows.reduce((map, row) => {
    const k = key(row)
    map.set(k, [...(map.get(k) ?? []), row])
    return map
  }, new Map<string, T[]>())
}

/**
 * Openings for each provider in [window.from, window.to), never before `now`, each at least
 * `minMinutes` long. Capacity is crew-aware (D-041).
 */
export async function loadAvailability(
  pool: pg.Pool,
  providers: readonly { id: string; crewSize: number | null }[],
  window: { from: string; to: string },
  now: string,
  minMinutes: number,
): Promise<Map<string, ProviderAvailability>> {
  const ids = providers.map((provider) => provider.id)
  if (ids.length === 0) return new Map()
  const [hours, work, blocks] = await Promise.all([
    pool.query<HoursRow>(
      `SELECT provider_id, weekday, start_local, end_local, always_open, sources
         FROM v_declared_hours
        WHERE provider_id = ANY ($1) ORDER BY provider_id, weekday, start_local`,
      [ids],
    ),
    // All work, not only the window's: history drives crew concurrency, inferred hours and the
    // outside-hours conflict.
    pool.query<WorkRow>(
      `SELECT id, provider_id, kind, status, start_at, end_at, all_day,
              to_char(rescheduled_from, 'YYYY-MM-DD') AS rescheduled_from, source_systems, sources
         FROM v_jobs WHERE provider_id = ANY ($1) AND start_at IS NOT NULL`,
      [ids],
    ),
    pool.query<BlockRow>(
      `SELECT provider_id, start_at, end_at, all_day, busy, category, mirrored_job_id, status,
              sources
         FROM v_calendar_blocks
        WHERE provider_id = ANY ($1) AND start_at < $3 AND end_at > $2`,
      [ids, window.from, window.to],
    ),
  ])
  const hoursBy = groupBy(hours.rows, (row) => row.provider_id)
  const workBy = groupBy(work.rows, (row) => row.provider_id)
  const blocksBy = groupBy(blocks.rows, (row) => row.provider_id)

  return new Map(
    providers.map((provider) => {
      const hourRows = hoursBy.get(provider.id) ?? []
      const declaredHours = hourRows.flatMap((row): WeeklyHours[] =>
        isWeekday(row.weekday)
          ? [{ weekday: row.weekday, start: row.start_local, end: row.end_local }]
          : [],
      )
      const workRows = (workBy.get(provider.id) ?? []).filter((row) => WORK_KINDS.has(row.kind))
      const history: HistoryItem[] = workRows
        .filter((row) => row.status !== 'cancelled' && row.start_at !== null)
        .map((row) => ({
          startAt: row.start_at?.toISOString() ?? '',
          endAt: iso(row.end_at),
          sources: readSources(row.sources),
        }))
      const blockRows = blocksBy.get(provider.id) ?? []
      const mirrorsOf = groupBy(
        blockRows.filter((row) => row.mirrored_job_id !== null),
        (row) => row.mirrored_job_id ?? '',
      )
      const busy = [
        ...workRows.map((row) => workBusy(row, mirrorsOf.get(row.id) ?? [])),
        // A calendar event that mirrors a CRM job is that job (D-047): count the booking once.
        ...blockRows.filter((row) => row.mirrored_job_id === null).map(blockBusy),
      ]
      const result = computeAvailability({
        declaredHours: declaredHours.length === 0 ? null : declaredHours,
        crewSize: provider.crewSize,
        history,
        busy,
        window,
        now,
        minMinutes,
        // G20: "24/7" is a claim, not a working pattern; the engine infers hours instead.
        declaredAlwaysOpen: hourRows.some((row) => row.always_open),
      })
      const hoursSources = hourRows.reduce((map, row) => {
        map.set(row.weekday, mergeSources(map.get(row.weekday) ?? [], readSources(row.sources)))
        return map
      }, new Map<number, Source[]>())
      return [provider.id, { providerId: provider.id, result, hoursSources }] as const
    }),
  )
}

function isoWeekdayOf(instant: string): number {
  return DateTime.fromISO(instant, { setZone: true }).setZone(TIME_ZONE).weekday
}

/** Opening with local offsets, localized reasons and its citations (hours and bounding items). */
export function presentOpening(
  opening: Opening,
  hoursSources: Map<number, Source[]>,
): PresentedOpening {
  const sources = mergeSources(
    hoursSources.get(isoWeekdayOf(opening.start)) ?? [],
    opening.boundedBy,
  )
  return {
    start: presentInstant(opening.start),
    end: presentInstant(opening.end),
    minutes: Math.round(opening.minutes),
    confidence: opening.confidence,
    reasons: opening.reasons.map(localizeInstants),
    ...(sources.length > 0 ? { sources } : {}),
  }
}

export function presentOpenings(
  availability: ProviderAvailability | undefined,
  limit: number,
): PresentedOpening[] {
  if (availability === undefined) return []
  return availability.result.openings
    .slice(0, limit)
    .map((opening) => presentOpening(opening, availability.hoursSources))
}

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 }

export function bestConfidence(openings: readonly { confidence: Confidence }[]): Confidence | null {
  return openings.reduce<Confidence | null>(
    (best, opening) =>
      best === null || RANK[opening.confidence] > RANK[best] ? opening.confidence : best,
    null,
  )
}
