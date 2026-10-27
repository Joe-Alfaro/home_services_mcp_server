import type {
  AvailabilityInput,
  BusyItem,
  HistoryItem,
  Opening,
  SourceCitation,
  WeeklyHours,
} from '../../../src/availability/engine.ts'

// Hand-made availability fixtures. Every instant is written out in UTC with its Chicago wall
// time alongside, so the expected values never depend on the code under test.
// 2026-11-01 is the Sunday DST ends: CDT (UTC-5) before 02:00 local, CST (UTC-6) after.

/** UTC ISO instant with a trailing Z; milliseconds optional. */
export const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/

/** Default "now": 2026-11-02 00:00 CST. */
export const NOW = '2026-11-02T06:00:00Z'

/** Next 3 days: [Mon 2026-11-02 00:00 CST, Thu 2026-11-05 00:00 CST). */
export const NEXT_3_DAYS = { from: '2026-11-02T06:00:00Z', to: '2026-11-05T06:00:00Z' }

/** Mon-Fri 08:00-17:00 local. On CST days that is 14:00Z-23:00Z. */
export const WEEKDAYS_8_TO_5: WeeklyHours[] = ([1, 2, 3, 4, 5] as const).map((weekday) => ({
  weekday,
  start: '08:00',
  end: '17:00',
}))

/** Every day 08:00-17:00 local. */
export const EVERY_DAY_8_TO_5: WeeklyHours[] = ([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({
  weekday,
  start: '08:00',
  end: '17:00',
}))

export function ref(sourceRecordId: string, sourceSystem = 'housecall_pro'): SourceCitation {
  return {
    sourceSystem,
    sourceFile: `fixtures/${sourceSystem}/acme_fixture.json`,
    sourceRecordId,
  }
}

export function busyItem(
  id: string,
  startAt: string | null,
  endAt: string | null,
  overrides: Partial<BusyItem> = {},
): BusyItem {
  return {
    kind: 'job',
    status: 'scheduled',
    startAt,
    endAt,
    allDay: false,
    busy: true,
    confidence: 'high',
    sources: [ref(id)],
    ...overrides,
  }
}

export function calendarBlock(
  id: string,
  startAt: string,
  endAt: string,
  overrides: Partial<BusyItem> = {},
): BusyItem {
  return busyItem(id, startAt, endAt, {
    kind: 'calendar_block',
    status: 'confirmed',
    sources: [ref(id, 'ics')],
    ...overrides,
  })
}

export function historyItem(id: string, startAt: string, endAt: string | null): HistoryItem {
  return { startAt, endAt, sources: [ref(id, 'jobber')] }
}

/** A recent completed job inside declared hours: Mon 2026-10-26 09:00-10:00 CDT. */
export const RECENT_IN_HOURS_JOB = historyItem(
  'hist-1',
  '2026-10-26T14:00:00Z',
  '2026-10-26T15:00:00Z',
)

/**
 * A single-crew provider with Mon-Fri 08-17 hours, recent in-hours work, nothing booked, looking
 * at the next 3 days from the default "now".
 */
export function makeInput(overrides: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    declaredHours: WEEKDAYS_8_TO_5,
    crewSize: 1,
    history: [RECENT_IN_HOURS_JOB],
    busy: [],
    window: NEXT_3_DAYS,
    now: NOW,
    ...overrides,
  }
}

/** Normalizes an instant to "YYYY-MM-DDTHH:mm:ssZ" so tests don't care about milliseconds. */
export function iso(instant: string): string {
  return new Date(instant).toISOString().replace('.000Z', 'Z')
}

/** "start/end" per opening, normalized, in output order. */
export function spans(openings: readonly Pick<Opening, 'start' | 'end'>[]): string[] {
  return openings.map((opening) => `${iso(opening.start)}/${iso(opening.end)}`)
}

/** Openings that start on the given UTC date prefix, e.g. "2026-11-02". */
export function startingOn(openings: readonly Opening[], date: string): Opening[] {
  return openings.filter((o) => iso(o.start).startsWith(date))
}

export function opening(start: string, end: string, overrides: Partial<Opening> = {}): Opening {
  return {
    start,
    end,
    minutes: (Date.parse(end) - Date.parse(start)) / 60_000,
    confidence: 'high',
    reasons: [],
    boundedBy: [],
    ...overrides,
  }
}
