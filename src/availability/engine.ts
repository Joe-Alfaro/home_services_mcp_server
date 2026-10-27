import type { Confidence } from './confidence.ts'
import { busyItemConfidence, capConfidence } from './confidence.ts'
import { inferWeeklyHours } from './inferredHours.ts'
import {
  localDateKey,
  localDateTime,
  localDaysBetween,
  localTimeOnDay,
  minuteOfDay,
  parseMinuteOfDay,
  toInstant,
} from './time.ts'

/** UTC ISO-8601 with a trailing Z. */
export type Instant = string
/** "YYYY-MM-DD" in America/Chicago. */
export type LocalDate = string

/** ISO weekday (1 = Monday … 7 = Sunday), local "HH:mm". */
export interface WeeklyHours {
  weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7
  start: string
  end: string
}

export interface SourceCitation {
  sourceSystem: string
  sourceFile: string
  sourceRecordId: string
}

/**
 * The provider's observed work (any status with a slot): drives observed crew concurrency,
 * inferred hours and the "work outside declared hours" conflict.
 */
export interface HistoryItem {
  startAt: Instant
  endAt: Instant | null
  sources: SourceCitation[]
}

export type BusyStatus =
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'on_hold'
  | 'unscheduled'
  | 'limbo'
  | 'confirmed' // ICS STATUS
  | 'tentative' // ICS STATUS

export interface BusyItem {
  kind: 'job' | 'visit' | 'estimate' | 'calendar_block'
  status: BusyStatus
  startAt: Instant | null
  /** null → defaultDurationMinutes, with a reason. */
  endAt: Instant | null
  allDay: boolean
  /** false for ICS TRANSPARENT or a CXL summary. */
  busy: boolean
  /** Upstream confidence, e.g. 'low' for a CSV-only future row. */
  confidence: Confidence
  /** One per merged source record. */
  sources: SourceCitation[]
  /** Evidence only; the old slot never blocks. */
  rescheduledFrom?: LocalDate | null
  /**
   * Calendar blocks only; missing means 'unknown'. CRM jobs, visits and estimates are work. Only
   * work counts toward the "work outside declared hours" conflict.
   */
  category?: 'work' | 'personal' | 'unknown'
}

export interface AvailabilityInput {
  /** null = none or unparseable → inferred hours. */
  declaredHours: WeeklyHours[] | null
  crewSize: number | null
  history: HistoryItem[]
  busy: BusyItem[]
  /** Half-open [from, to). */
  window: { from: Instant; to: Instant }
  /** From config, never the clock (R14). */
  now: Instant
  /** Default 0: keep every non-empty opening. */
  minMinutes?: number
  /** Default 60. */
  defaultDurationMinutes?: number
  /**
   * From DeclaredHoursCandidate.alwaysOpen: "24/7" is a claim, not a working pattern, so the
   * declared hours are ignored and hours are inferred from history, at low confidence (G20).
   */
  declaredAlwaysOpen?: boolean
}

/** An interval the engine treats as busy (one per blocking item; end defaulted when missing). */
export interface Block {
  start: Instant
  end: Instant
  confidence: Confidence
  reasons: string[]
  sources: SourceCitation[]
}

export interface Opening {
  start: Instant
  end: Instant
  minutes: number
  confidence: Confidence
  reasons: string[]
  /** Sources of the busy items that end at `start` or are busy at `end`. */
  boundedBy: SourceCitation[]
}

export interface AvailabilityResult {
  capacity: number
  hoursSource: 'declared' | 'inferred' | 'none'
  /** Maximal contiguous open intervals, sorted by start. */
  openings: Opening[]
  blocks: Block[]
}

const DEFAULT_DURATION_MINUTES = 60
const MINUTE_MS = 60_000
const NON_BLOCKING_STATUSES: ReadonlySet<BusyStatus> = new Set(['cancelled', 'completed'])

interface Span {
  startMs: number
  endMs: number
}

interface TimedBlock extends Span {
  block: Block
  /** Local dates the block touches; a low block lowers openings on these days. */
  localDates: Set<string>
  multiDay: boolean
}

/** Max number of simultaneously open half-open intervals; items without an end are ignored. */
export function maxConcurrency(
  intervals: readonly { startAt: Instant; endAt: Instant | null }[],
): number {
  const edges = intervals
    .flatMap(({ startAt, endAt }) =>
      endAt === null
        ? []
        : [
            { at: Date.parse(startAt), delta: 1 },
            { at: Date.parse(endAt), delta: -1 },
          ],
    )
    // Ends sort before starts at the same instant: touching intervals don't overlap.
    .sort((a, b) => a.at - b.at || a.delta - b.delta)
  return edges.reduce(
    (state, edge) => {
      const open = state.open + edge.delta
      return { open, max: Math.max(state.max, open) }
    },
    { open: 0, max: 0 },
  ).max
}

/** D-041: min(crewSize, observed max concurrency), at least 1; 1 when crewSize is null. */
export function crewCapacity(crewSize: number | null, history: readonly HistoryItem[]): number {
  if (crewSize === null) return 1
  return Math.max(1, Math.min(crewSize, maxConcurrency(history)))
}

function byStart(a: Opening, b: Opening): number {
  return Date.parse(a.start) - Date.parse(b.start)
}

/** The first n openings by start. */
export function nextOpenings(openings: readonly Opening[], n: number): Opening[] {
  return [...openings].sort(byStart).slice(0, Math.max(0, n))
}

/** Openings clipped to [from, to), then kept when minutes >= minMinutes; sorted by start. */
export function filterOpenings(
  openings: readonly Opening[],
  filter: { from: Instant; to: Instant; minMinutes: number },
): Opening[] {
  const fromMs = Date.parse(filter.from)
  const toMs = Date.parse(filter.to)
  return openings
    .flatMap((o) => {
      const startMs = Math.max(Date.parse(o.start), fromMs)
      const endMs = Math.min(Date.parse(o.end), toMs)
      if (endMs <= startMs) return []
      const minutes = (endMs - startMs) / MINUTE_MS
      if (minutes < filter.minMinutes) return []
      return [{ ...o, start: toInstant(startMs), end: toInstant(endMs), minutes }]
    })
    .sort(byStart)
}

/**
 * A completed item still blocks when its slot contains "now": the part after now is the work
 * running (G25, D-081). Cancelled items never block; a cancelled job leaves nobody on site.
 */
function blocks(item: BusyItem, nowMs: number, defaultMinutes: number): boolean {
  if (!item.busy || item.startAt === null) return false
  if (!NON_BLOCKING_STATUSES.has(item.status)) return true
  if (item.status !== 'completed') return false
  const startMs = Date.parse(item.startAt)
  const endMs = item.endAt === null ? startMs + defaultMinutes * MINUTE_MS : Date.parse(item.endAt)
  return startMs < nowMs && endMs > nowMs
}

function isWork(item: BusyItem): boolean {
  return item.kind !== 'calendar_block' || item.category === 'work'
}

function localDatesOf(span: Span): Set<string> {
  // The end is exclusive: a block ending at local midnight doesn't touch the next day.
  const lastMs = Math.max(span.startMs, span.endMs - 1)
  return new Set(localDaysBetween(span.startMs, lastMs).map(localDateKey))
}

function toTimedBlock(item: BusyItem, startAt: Instant, defaultMinutes: number): TimedBlock {
  const startMs = Date.parse(startAt)
  const endMs = item.endAt === null ? startMs + defaultMinutes * MINUTE_MS : Date.parse(item.endAt)
  const span = { startMs, endMs }
  const localDates = localDatesOf(span)
  const multiDay = !item.allDay && localDates.size > 1
  const { confidence, reasons } = busyItemConfidence(item)
  return {
    ...span,
    localDates,
    multiDay,
    block: {
      start: toInstant(startMs),
      end: toInstant(endMs),
      confidence,
      reasons: multiDay
        ? [...reasons, 'multi_day_span: clipped to declared hours on each day']
        : reasons,
      sources: item.sources,
    },
  }
}

function hoursByWeekday(hours: readonly WeeklyHours[]): Map<number, Span[]> {
  return hours.reduce((map, h) => {
    const span = { startMs: parseMinuteOfDay(h.start), endMs: parseMinuteOfDay(h.end) }
    map.set(h.weekday, [...(map.get(h.weekday) ?? []), span])
    return map
  }, new Map<number, Span[]>())
}

/** Weekly hours materialized per local date (so DST days are right), clipped to [fromMs, toMs). */
function materializeHours(hours: readonly WeeklyHours[], fromMs: number, toMs: number): Span[] {
  const weekly = hoursByWeekday(hours)
  return localDaysBetween(fromMs, toMs)
    .flatMap((day) =>
      (weekly.get(day.weekday) ?? []).map((minutes) => ({
        startMs: Math.max(localTimeOnDay(day, minutes.startMs), fromMs),
        endMs: Math.min(localTimeOnDay(day, minutes.endMs), toMs),
      })),
    )
    .filter((span) => span.endMs > span.startMs)
    .sort((a, b) => a.startMs - b.startMs)
}

/** True when [startMs, endMs) sits inside the declared hours of its local start day. */
function withinDeclaredHours(weekly: Map<number, Span[]>, startMs: number, endMs: number): boolean {
  const start = localDateTime(startMs)
  const end = localDateTime(Math.max(startMs, endMs - 1))
  if (localDateKey(start) !== localDateKey(end)) return false
  const startMinute = minuteOfDay(start)
  // `end` is the last millisecond inside the item, so its minute + 1 is the exclusive end minute.
  const endMinute = endMs > startMs ? minuteOfDay(end) + 1 : startMinute
  return (weekly.get(start.weekday) ?? []).some(
    (span) => startMinute >= span.startMs && endMinute <= span.endMs,
  )
}

function outsideHoursReason(
  hours: readonly WeeklyHours[],
  history: readonly HistoryItem[],
  bookedWork: readonly TimedBlock[],
): string | null {
  const weekly = hoursByWeekday(hours)
  const historyWork = history.flatMap((item) => {
    const startMs = Date.parse(item.startAt)
    const endMs = item.endAt === null ? startMs : Date.parse(item.endAt)
    // Multi-day spans run past declared hours by nature (G11); they are not a conflict.
    if (localDatesOf({ startMs, endMs }).size > 1) return []
    return [{ startMs, endMs, sources: item.sources }]
  })
  const booked = bookedWork
    .filter((t) => !t.multiDay)
    .map((t) => ({ startMs: t.startMs, endMs: t.endMs, sources: t.block.sources }))
  const offender = [...historyWork, ...booked].find(
    (work) => !withinDeclaredHours(weekly, work.startMs, work.endMs),
  )
  if (offender === undefined) return null
  const cited = offender.sources[0]
  const where = cited === undefined ? '' : ` (${cited.sourceSystem} ${cited.sourceRecordId})`
  return `work observed outside declared hours${where}`
}

/** Busy count per elementary segment of [span.startMs, span.endMs). */
function segmentsOf(span: Span, timed: readonly TimedBlock[]): (Span & { busy: number })[] {
  const overlapping = timed.filter((t) => t.startMs < span.endMs && t.endMs > span.startMs)
  const cuts = [
    ...new Set([span.startMs, span.endMs, ...overlapping.flatMap((t) => [t.startMs, t.endMs])]),
  ]
    .filter((at) => at >= span.startMs && at <= span.endMs)
    .sort((a, b) => a - b)
  return cuts.slice(1).map((endMs, index) => {
    const startMs = cuts[index] ?? span.startMs
    const busy = overlapping.filter((t) => t.startMs <= startMs && t.endMs > startMs).length
    return { startMs, endMs, busy }
  })
}

/** Maximal open intervals (busy < capacity) with the most busy items seen inside each. */
function openSpans(
  hours: readonly Span[],
  timed: readonly TimedBlock[],
  capacity: number,
): (Span & { maxBusy: number })[] {
  return hours
    .flatMap((span) => segmentsOf(span, timed))
    .filter((segment) => segment.busy < capacity)
    .reduce<(Span & { maxBusy: number })[]>((merged, segment) => {
      const last = merged.at(-1)
      if (last !== undefined && last.endMs === segment.startMs) {
        return [
          ...merged.slice(0, -1),
          { ...last, endMs: segment.endMs, maxBusy: Math.max(last.maxBusy, segment.busy) },
        ]
      }
      return [...merged, { ...segment, maxBusy: segment.busy }]
    }, [])
}

/** Why a below-high block lowers openings on its day; cites the block when it has no reason. */
function lowBlockReasons(t: TimedBlock): string[] {
  if (t.block.reasons.length > 0) return t.block.reasons
  const cited = t.block.sources[0]
  const where = cited === undefined ? '' : ` (${cited.sourceSystem} ${cited.sourceRecordId})`
  return [`${t.block.confidence}-confidence booking that day${where}`]
}

function uniqueSources(sources: readonly SourceCitation[]): SourceCitation[] {
  const seen = new Set<string>()
  return sources.filter((s) => {
    const key = `${s.sourceSystem}\u0000${s.sourceFile}\u0000${s.sourceRecordId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * R13 availability: hours (declared, else inferred) minus busy items, crew-aware per D-041, with
 * the cautious confidence and its reasons on every opening. Pure: `now` comes from the input.
 */
export function computeAvailability(input: AvailabilityInput): AvailabilityResult {
  const capacity = crewCapacity(input.crewSize, input.history)
  const defaultMinutes = input.defaultDurationMinutes ?? DEFAULT_DURATION_MINUTES
  const minMinutes = input.minMinutes ?? 0
  const windowFromMs = Date.parse(input.window.from)
  const windowToMs = Date.parse(input.window.to)
  const fromMs = Math.max(windowFromMs, Date.parse(input.now))

  const alwaysOpen = input.declaredAlwaysOpen === true
  const declaredHours = alwaysOpen ? null : input.declaredHours
  const inferred = declaredHours === null ? inferWeeklyHours(input.history, { now: input.now }) : []
  const hours = declaredHours ?? inferred
  const hoursSource =
    declaredHours !== null ? 'declared' : inferred.length > 0 ? 'inferred' : 'none'

  const nowMs = Date.parse(input.now)
  const blocking = input.busy.flatMap((item) =>
    blocks(item, nowMs, defaultMinutes) && item.startAt !== null
      ? [{ item, timed: toTimedBlock(item, item.startAt, defaultMinutes) }]
      : [],
  )
  const timed = blocking
    .map(({ timed: t }) => t)
    .filter((t) => t.startMs < windowToMs && t.endMs > windowFromMs)
    .sort((a, b) => a.startMs - b.startMs)
  // Booked work anywhere (not only in the window) counts toward the outside-hours conflict.
  const bookedWork = blocking.filter(({ item }) => isWork(item)).map(({ timed: t }) => t)

  // Reasons and caps that apply to every opening.
  const globalCaps: { cap: Confidence; reason: string }[] = []
  if (hoursSource === 'inferred') {
    globalCaps.push({
      cap: 'low',
      reason: alwaysOpen
        ? 'declared hours are 24/7 (always open), not a working pattern; hours inferred from observed work'
        : 'hours inferred from observed work (none declared)',
    })
  }
  if (hoursSource === 'declared') {
    const conflict = outsideHoursReason(hours, input.history, bookedWork)
    if (conflict !== null) globalCaps.push({ cap: 'medium', reason: conflict })
  }
  if (input.crewSize !== null && input.crewSize > capacity) {
    globalCaps.push({
      cap: 'medium',
      reason: `declared crew of ${String(input.crewSize)} exceeds observed concurrency; treated as ${String(capacity)} schedule(s)`,
    })
  }

  const lowBlocks = timed.filter((t) => t.block.confidence !== 'high')
  const openings = openSpans(materializeHours(hours, fromMs, windowToMs), timed, capacity)
    .map((span): Opening => {
      const day = localDateKey(localDateTime(span.startMs))
      const sameDayLow = lowBlocks.filter((t) => t.localDates.has(day))
      const laneCap =
        span.maxBusy > 0
          ? [
              {
                cap: 'medium' as const,
                reason: `free crew lane (${String(span.maxBusy)} of ${String(capacity)} busy)`,
              },
            ]
          : []
      const caps = [
        ...globalCaps,
        ...laneCap,
        ...sameDayLow.flatMap((t) =>
          lowBlockReasons(t).map((reason) => ({ cap: t.block.confidence, reason })),
        ),
      ]
      const boundedBy = uniqueSources(
        timed
          .filter(
            (t) => t.endMs === span.startMs || (t.startMs <= span.endMs && t.endMs > span.endMs),
          )
          .flatMap((t) => t.block.sources),
      )
      return {
        start: toInstant(span.startMs),
        end: toInstant(span.endMs),
        minutes: (span.endMs - span.startMs) / MINUTE_MS,
        confidence: caps.reduce<Confidence>((level, c) => capConfidence(level, c.cap), 'high'),
        reasons: [...new Set(caps.map((c) => c.reason))],
        boundedBy,
      }
    })
    .filter((o) => o.minutes > 0 && o.minutes >= minMinutes)

  return {
    capacity,
    hoursSource,
    openings,
    blocks: timed.map((t) => t.block),
  }
}
