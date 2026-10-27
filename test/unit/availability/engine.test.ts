/*
 * Expected API of src/availability/engine.ts (pure: no clock, no database, no host time zone;
 * declared hours are America/Chicago wall time, materialized per local date so DST days are right).
 *
 *   import type { Confidence } from './confidence.ts'
 *
 *   export type Instant = string // UTC ISO-8601 with a trailing Z
 *   export type LocalDate = string // "YYYY-MM-DD" in America/Chicago
 *
 *   // ISO weekday (1 = Monday … 7 = Sunday), local "HH:mm".
 *   export interface WeeklyHours { weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7; start: string; end: string }
 *   export interface SourceCitation { sourceSystem: string; sourceFile: string; sourceRecordId: string }
 *
 *   // The provider's observed work (any status with a slot): drives observed crew concurrency,
 *   // inferred hours and the "work outside declared hours" conflict.
 *   export interface HistoryItem { startAt: Instant; endAt: Instant | null; sources: SourceCitation[] }
 *
 *   export type BusyStatus =
 *     | 'scheduled' | 'in_progress' | 'completed' | 'cancelled' | 'on_hold' | 'unscheduled' | 'limbo'
 *     | 'confirmed' | 'tentative' // ICS STATUS
 *   export interface BusyItem {
 *     kind: 'job' | 'visit' | 'estimate' | 'calendar_block'
 *     status: BusyStatus
 *     startAt: Instant | null
 *     endAt: Instant | null // null → defaultDurationMinutes, with a reason
 *     allDay: boolean
 *     busy: boolean // false for ICS TRANSPARENT or a CXL summary
 *     confidence: Confidence // upstream confidence, e.g. 'low' for a CSV-only future row
 *     sources: SourceCitation[] // one per merged source record
 *     rescheduledFrom?: LocalDate | null // evidence only; the old slot never blocks
 *     // Calendar blocks only; missing means 'unknown'. CRM jobs, visits and estimates are work.
 *     // Only work counts toward the "work outside declared hours" conflict.
 *     category?: 'work' | 'personal' | 'unknown'
 *   }
 *
 *   export interface AvailabilityInput {
 *     declaredHours: WeeklyHours[] | null // null = none or unparseable → inferred hours
 *     crewSize: number | null
 *     history: HistoryItem[]
 *     busy: BusyItem[]
 *     window: { from: Instant; to: Instant } // half-open [from, to)
 *     now: Instant // from config, never the clock
 *     minMinutes?: number // default 0: keep every non-empty opening
 *     defaultDurationMinutes?: number // default 60
 *   }
 *
 *   // An interval the engine treats as busy (one per blocking item; end defaulted when missing).
 *   export interface Block {
 *     start: Instant; end: Instant; confidence: Confidence; reasons: string[]; sources: SourceCitation[]
 *   }
 *   export interface Opening {
 *     start: Instant
 *     end: Instant
 *     minutes: number
 *     confidence: Confidence
 *     reasons: string[]
 *     boundedBy: SourceCitation[] // sources of the busy items that end at `start` or are busy at `end`
 *   }
 *   export interface AvailabilityResult {
 *     capacity: number
 *     hoursSource: 'declared' | 'inferred' | 'none'
 *     openings: Opening[] // maximal contiguous open intervals, sorted by start
 *     blocks: Block[]
 *   }
 *
 *   export function computeAvailability(input: AvailabilityInput): AvailabilityResult
 *   // Max number of simultaneously open half-open intervals; items without an end are ignored.
 *   export function maxConcurrency(intervals: readonly { startAt: Instant; endAt: Instant | null }[]): number
 *   // min(crewSize, maxConcurrency(history)), at least 1; 1 when crewSize is null.
 *   export function crewCapacity(crewSize: number | null, history: readonly HistoryItem[]): number
 *   // The first n openings by start.
 *   export function nextOpenings(openings: readonly Opening[], n: number): Opening[]
 *   // Openings clipped to [from, to), then kept when minutes >= minMinutes; sorted by start.
 *   export function filterOpenings(
 *     openings: readonly Opening[], filter: { from: Instant; to: Instant; minMinutes: number },
 *   ): Opening[]
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  computeAvailability,
  crewCapacity,
  filterOpenings,
  maxConcurrency,
  nextOpenings,
} from '../../../src/availability/engine.ts'
import type { BusyItem } from '../../../src/availability/engine.ts'
import { loadConfig } from '../../../src/config.ts'
import {
  EVERY_DAY_8_TO_5,
  NOW,
  UTC_INSTANT,
  busyItem,
  calendarBlock,
  historyItem,
  iso,
  makeInput,
  opening,
  ref,
  spans,
  startingOn,
} from './support.ts'

const MON_FULL = '2026-11-02T14:00:00Z/2026-11-02T23:00:00Z'
const TUE_FULL = '2026-11-03T14:00:00Z/2026-11-03T23:00:00Z'
const WED_FULL = '2026-11-04T14:00:00Z/2026-11-04T23:00:00Z'

/** Mon 2026-11-02 10:00-12:00 CST. */
const MON_10_TO_12 = { start: '2026-11-02T16:00:00Z', end: '2026-11-02T18:00:00Z' }
const MON_WITH_10_TO_12_BOOKED = [
  '2026-11-02T14:00:00Z/2026-11-02T16:00:00Z',
  '2026-11-02T18:00:00Z/2026-11-02T23:00:00Z',
]

describe('R13 (a) declared hours minus booked work', () => {
  it('R13(a): Mon-Fri 8-17 with a job 10-12 yields openings 8-10 and 12-17', () => {
    const job = busyItem('job-1', MON_10_TO_12.start, MON_10_TO_12.end)
    const result = computeAvailability(makeInput({ busy: [job] }))

    expect(result.hoursSource).toBe('declared')
    expect(result.capacity).toBe(1)
    expect(spans(result.openings)).toEqual([...MON_WITH_10_TO_12_BOOKED, TUE_FULL, WED_FULL])
    expect(result.openings.map((o) => o.minutes)).toEqual([120, 300, 540, 540])
    result.openings.forEach((o) => {
      expect(o.confidence).toBe('high')
      expect(o.start).toMatch(UTC_INSTANT)
      expect(o.end).toMatch(UTC_INSTANT)
    })
  })

  it('R13(a): each opening cites the source refs of the busy items that bound it', () => {
    const job = busyItem('job-1', MON_10_TO_12.start, MON_10_TO_12.end)
    const [before, after, tuesday] = computeAvailability(makeInput({ busy: [job] })).openings

    expect(before?.boundedBy).toEqual([ref('job-1')])
    expect(after?.boundedBy).toEqual([ref('job-1')])
    expect(tuesday?.boundedBy).toEqual([])
  })

  it('G17/R11: a booking merged from a CRM job and its calendar mirror cites both sources', () => {
    const merged = busyItem('job-1', MON_10_TO_12.start, MON_10_TO_12.end, {
      sources: [ref('job-1'), ref('evt-1@2026-11-02T16:00:00Z', 'ics')],
    })
    const [before] = computeAvailability(makeInput({ busy: [merged] })).openings

    expect(before?.boundedBy).toEqual(
      expect.arrayContaining([ref('job-1'), ref('evt-1@2026-11-02T16:00:00Z', 'ics')]),
    )
  })

  it('R13: openings are sorted by start and never overlap, whatever the input order', () => {
    const busy = [
      busyItem('job-c', '2026-11-04T20:00:00Z', '2026-11-04T21:00:00Z'),
      busyItem('job-a', '2026-11-02T20:00:00Z', '2026-11-02T21:00:00Z'),
      calendarBlock('evt-b', '2026-11-03T15:00:00Z', '2026-11-03T16:00:00Z'),
    ]
    const { openings } = computeAvailability(makeInput({ busy }))

    expect(openings.length).toBe(6)
    openings.slice(1).forEach((o, index) => {
      const previous = openings[index]
      expect(Date.parse(o.start)).toBeGreaterThanOrEqual(Date.parse(previous?.end ?? ''))
    })
  })

  it('R13: overlapping busy items on a single crew merge into one gap', () => {
    const busy = [
      busyItem('job-1', '2026-11-02T16:00:00Z', '2026-11-02T18:00:00Z'),
      calendarBlock('evt-1', '2026-11-02T17:00:00Z', '2026-11-02T19:00:00Z'),
    ]
    const monday = startingOn(computeAvailability(makeInput({ busy })).openings, '2026-11-02')

    expect(spans(monday)).toEqual([
      '2026-11-02T14:00:00Z/2026-11-02T16:00:00Z',
      '2026-11-02T19:00:00Z/2026-11-02T23:00:00Z',
    ])
  })
})

describe('R13 (b)-(d) calendar blocks', () => {
  it('R13(b): a busy calendar event inside declared hours removes that time', () => {
    // Tue 13:00-14:30 CST.
    const event = calendarBlock('evt-1', '2026-11-03T19:00:00Z', '2026-11-03T20:30:00Z')
    const tuesday = startingOn(
      computeAvailability(makeInput({ busy: [event] })).openings,
      '2026-11-03',
    )

    expect(spans(tuesday)).toEqual([
      '2026-11-03T14:00:00Z/2026-11-03T19:00:00Z',
      '2026-11-03T20:30:00Z/2026-11-03T23:00:00Z',
    ])
  })

  it('R13(c)/R12(d): an all-day event removes the whole local day', () => {
    const allDay = calendarBlock('evt-ooo', '2026-11-03T06:00:00Z', '2026-11-04T06:00:00Z', {
      allDay: true,
    })
    const { openings } = computeAvailability(makeInput({ busy: [allDay] }))

    expect(spans(openings)).toEqual([MON_FULL, WED_FULL])
  })

  it('G17/R13(c): a multi-day all-day event (Nov 4 to exclusive Nov 9) blocks Nov 4-8 only', () => {
    const outOfOffice = calendarBlock('evt-ooo', '2026-11-04T06:00:00Z', '2026-11-09T06:00:00Z', {
      allDay: true,
    })
    const window = { from: '2026-11-02T06:00:00Z', to: '2026-11-11T06:00:00Z' }
    const { openings } = computeAvailability(makeInput({ busy: [outOfOffice], window }))

    expect(spans(openings)).toEqual([
      MON_FULL,
      TUE_FULL,
      '2026-11-09T14:00:00Z/2026-11-09T23:00:00Z',
      '2026-11-10T14:00:00Z/2026-11-10T23:00:00Z',
    ])
  })

  it('R13(d): a recurring weekday event removes every occurrence in the window', () => {
    // Weekdays 15:00-15:45 local, already expanded by the ICS adapter, one block per occurrence.
    const occurrences = [
      '2026-10-30T20:00:00Z', // Fri 15:00 CDT, before the window
      '2026-11-02T21:00:00Z',
      '2026-11-03T21:00:00Z',
      '2026-11-04T21:00:00Z',
      '2026-11-05T21:00:00Z', // Thu, after the window
    ].map((start) =>
      calendarBlock(
        `pickup@${start}`,
        start,
        new Date(Date.parse(start) + 45 * 60_000).toISOString(),
      ),
    )
    const { openings } = computeAvailability(makeInput({ busy: occurrences }))

    expect(spans(openings)).toEqual([
      '2026-11-02T14:00:00Z/2026-11-02T21:00:00Z',
      '2026-11-02T21:45:00Z/2026-11-02T23:00:00Z',
      '2026-11-03T14:00:00Z/2026-11-03T21:00:00Z',
      '2026-11-03T21:45:00Z/2026-11-03T23:00:00Z',
      '2026-11-04T14:00:00Z/2026-11-04T21:00:00Z',
      '2026-11-04T21:45:00Z/2026-11-04T23:00:00Z',
    ])
  })

  it('R13(d)/G17: weekly Thursday 16:30-18:00 occurrences across the DST change block 16:30 CST', () => {
    const occurrences = [
      ['2026-10-29T21:30:00Z', '2026-10-29T23:00:00Z'], // 16:30 CDT
      ['2026-11-05T22:30:00Z', '2026-11-06T00:00:00Z'], // 16:30 CST
      ['2026-11-12T22:30:00Z', '2026-11-13T00:00:00Z'],
    ].map(([start = '', end = '']) => calendarBlock(`thu@${start}`, start, end))
    const window = { from: '2026-11-02T06:00:00Z', to: '2026-11-13T06:00:00Z' }
    const { openings } = computeAvailability(makeInput({ busy: occurrences, window }))

    expect(spans(startingOn(openings, '2026-11-05'))).toEqual([
      '2026-11-05T14:00:00Z/2026-11-05T22:30:00Z',
    ])
    expect(spans(startingOn(openings, '2026-11-12'))).toEqual([
      '2026-11-12T14:00:00Z/2026-11-12T22:30:00Z',
    ])
    expect(startingOn(openings, '2026-11-05')[0]?.boundedBy).toEqual([
      ref('thu@2026-11-05T22:30:00Z', 'ics'),
    ])
  })
})

describe('R13 (e) inferred hours', () => {
  // Observed Monday work in the last 90 days: 09:00-11:00, 13:00-15:00, 10:00-12:00 CDT.
  const mondayHistory = [
    historyItem('h-1', '2026-10-12T14:00:00Z', '2026-10-12T16:00:00Z'),
    historyItem('h-2', '2026-10-19T18:00:00Z', '2026-10-19T20:00:00Z'),
    historyItem('h-3', '2026-10-26T15:00:00Z', '2026-10-26T17:00:00Z'),
    // Tue 2026-07-07: older than 90 days, so no Tuesday hours are inferred.
    historyItem('h-old', '2026-07-07T14:00:00Z', '2026-07-07T16:00:00Z'),
  ]

  it('R13(e): no declared hours → openings only from inferred hours, at low confidence with a reason', () => {
    const result = computeAvailability(
      makeInput({ declaredHours: null, crewSize: null, history: mondayHistory }),
    )

    expect(result.hoursSource).toBe('inferred')
    // Inferred Monday 09:00-15:00 local, materialized on a CST Monday.
    expect(spans(result.openings)).toEqual(['2026-11-02T15:00:00Z/2026-11-02T21:00:00Z'])
    expect(result.openings[0]?.confidence).toBe('low')
    expect(result.openings[0]?.reasons).toEqual(
      expect.arrayContaining([expect.stringMatching(/inferred/i)]),
    )
  })

  it('R13(e)/G20: no declared hours and no observed work → no openings claimed', () => {
    const result = computeAvailability(makeInput({ declaredHours: null, history: [] }))

    expect(result.hoursSource).toBe('none')
    expect(result.openings).toEqual([])
  })
})

describe('R13 (f) work outside declared hours', () => {
  const outsideHours = /outside declared hours/i

  it('R13(f)/G23: observed work on an undeclared day caps every opening at medium with a conflict reason', () => {
    // Sat 2026-10-24 10:00-12:00 CDT; declared hours are Mon-Fri only.
    const history = [
      historyItem('h-sat', '2026-10-24T15:00:00Z', '2026-10-24T17:00:00Z'),
      historyItem('h-1', '2026-10-26T14:00:00Z', '2026-10-26T15:00:00Z'),
    ]
    const { openings } = computeAvailability(makeInput({ history }))

    expect(openings.length).toBe(3)
    openings.forEach((o) => {
      expect(o.confidence).toBe('medium')
      expect(o.reasons).toEqual(expect.arrayContaining([expect.stringMatching(outsideHours)]))
    })
  })

  it('R13(f): a booking after declared hours (Wed 18:00-19:00) also raises the conflict', () => {
    const evening = busyItem('job-late', '2026-11-05T00:00:00Z', '2026-11-05T01:00:00Z')
    const { openings } = computeAvailability(makeInput({ busy: [evening] }))

    expect(spans(openings)).toEqual([MON_FULL, TUE_FULL, WED_FULL])
    openings.forEach((o) => {
      expect(o.confidence).toBe('medium')
      expect(o.reasons).toEqual(expect.arrayContaining([expect.stringMatching(outsideHours)]))
    })
  })

  it('R13(f): a calendar work event after declared hours raises the conflict', () => {
    const evening = calendarBlock('evt-job', '2026-11-05T00:00:00Z', '2026-11-05T01:00:00Z', {
      category: 'work',
    })
    const { openings } = computeAvailability(makeInput({ busy: [evening] }))

    openings.forEach((o) => {
      expect(o.confidence).toBe('medium')
      expect(o.reasons).toEqual(expect.arrayContaining([expect.stringMatching(outsideHours)]))
    })
  })

  it('R13(f): personal calendar events outside hours are not work and raise no conflict', () => {
    const evening = calendarBlock('evt-dinner', '2026-11-05T00:00:00Z', '2026-11-05T01:00:00Z', {
      category: 'personal',
    })
    const { openings } = computeAvailability(makeInput({ busy: [evening] }))

    openings.forEach((o) => {
      expect(o.confidence).toBe('high')
      expect(o.reasons).not.toEqual(expect.arrayContaining([expect.stringMatching(outsideHours)]))
    })
  })

  it('G11/D-022: a Sat 09:00 → Mon 12:00 job is clipped to declared hours with a multi_day_span reason and no conflict', () => {
    const hours = [
      { weekday: 6 as const, start: '09:00', end: '13:00' },
      { weekday: 1 as const, start: '08:00', end: '17:00' },
    ]
    // Sat 2026-11-07 09:00 CST → Mon 2026-11-09 12:00 CST.
    const span = busyItem('job-span', '2026-11-07T15:00:00Z', '2026-11-09T18:00:00Z', {
      sources: [ref('job-span', 'workiz')],
    })
    const window = { from: '2026-11-07T06:00:00Z', to: '2026-11-10T06:00:00Z' }
    const result = computeAvailability(makeInput({ declaredHours: hours, busy: [span], window }))

    expect(spans(result.openings)).toEqual(['2026-11-09T18:00:00Z/2026-11-09T23:00:00Z'])
    expect(result.openings[0]?.reasons).not.toEqual(
      expect.arrayContaining([expect.stringMatching(outsideHours)]),
    )
    const block = result.blocks.find((b) => b.sources.some((s) => s.sourceRecordId === 'job-span'))
    expect(block?.reasons).toEqual(
      expect.arrayContaining([expect.stringMatching(/multi_day_span/)]),
    )
  })
})

describe('R13 (g)/R14 openings never start before "now"', () => {
  it('R13(g): now inside declared hours clips the first opening to now', () => {
    // now = Mon 10:30 CST.
    const { openings } = computeAvailability(makeInput({ now: '2026-11-02T16:30:00Z' }))

    expect(spans(openings)).toEqual([
      '2026-11-02T16:30:00Z/2026-11-02T23:00:00Z',
      TUE_FULL,
      WED_FULL,
    ])
    expect(openings[0]?.minutes).toBe(390)
  })

  it('R13(g)/R14: the default config now (2026-11-02 00:00 CT) drops all of Sun 2026-11-01', () => {
    const { now } = loadConfig({})
    const window = { from: '2026-11-01T05:00:00Z', to: '2026-11-03T06:00:00Z' }
    const { openings } = computeAvailability(
      makeInput({ declaredHours: EVERY_DAY_8_TO_5, window, now }),
    )

    expect(spans(openings)).toEqual([MON_FULL])
  })

  it('R14: a configured today (HS_TODAY=2026-11-03) moves the first opening to Tuesday', () => {
    const { now } = loadConfig({ HS_TODAY: '2026-11-03' })
    const { openings } = computeAvailability(makeInput({ now }))

    expect(spans(openings)).toEqual([TUE_FULL, WED_FULL])
  })

  it('R13(g): now inside a booking starts the first opening when the booking ends', () => {
    const job = busyItem('job-1', MON_10_TO_12.start, MON_10_TO_12.end)
    const { openings } = computeAvailability(
      makeInput({ busy: [job], now: '2026-11-02T17:00:00Z' }),
    )

    expect(spans(openings)[0]).toBe('2026-11-02T18:00:00Z/2026-11-02T23:00:00Z')
  })

  it('R13(g): a window that ends before now has no openings', () => {
    const { openings } = computeAvailability(makeInput({ now: '2026-11-06T06:00:00Z' }))

    expect(openings).toEqual([])
  })

  it('G25: a job straddling midnight (Sun 23:00 → Mon 01:00 local) blocks until 01:00', () => {
    const hours = [{ weekday: 1 as const, start: '00:00', end: '06:00' }]
    const straddler = busyItem('job-night', '2026-11-02T05:00:00Z', '2026-11-02T07:00:00Z')
    const window = { from: '2026-11-02T06:00:00Z', to: '2026-11-03T06:00:00Z' }
    const { openings } = computeAvailability(
      makeInput({ declaredHours: hours, busy: [straddler], window }),
    )

    expect(spans(openings)).toEqual(['2026-11-02T07:00:00Z/2026-11-02T12:00:00Z'])
  })
})

describe('R12 declared hours across the DST change', () => {
  const originalTz = process.env.TZ
  afterEach(() => {
    if (originalTz === undefined) {
      delete process.env.TZ
      return
    }
    process.env.TZ = originalTz
  })

  const window = { from: '2026-10-31T05:00:00Z', to: '2026-11-03T06:00:00Z' }
  const expected = [
    '2026-10-31T13:00:00Z/2026-10-31T22:00:00Z', // Sat 08-17 CDT
    '2026-11-01T14:00:00Z/2026-11-01T23:00:00Z', // Sun 08-17 CST (DST ended at 02:00)
    '2026-11-02T14:00:00Z/2026-11-02T23:00:00Z', // Mon 08-17 CST
  ]

  it('R12/G1: declared 08:00-17:00 on 2026-10-31, 2026-11-01 and 2026-11-02 map to the right instants', () => {
    const { openings } = computeAvailability(
      makeInput({ declaredHours: EVERY_DAY_8_TO_5, window, now: '2026-10-30T05:00:00Z' }),
    )

    expect(spans(openings)).toEqual(expected)
    expect(openings.map((o) => o.minutes)).toEqual([540, 540, 540])
  })

  it('R12/G1: the result does not depend on the host time zone', () => {
    process.env.TZ = 'Asia/Tokyo'
    const { openings } = computeAvailability(
      makeInput({ declaredHours: EVERY_DAY_8_TO_5, window, now: '2026-10-30T05:00:00Z' }),
    )

    expect(spans(openings)).toEqual(expected)
  })
})

describe('D-041 crew-aware capacity', () => {
  it('D-041: maxConcurrency counts overlapping half-open intervals and ignores open-ended ones', () => {
    expect(maxConcurrency([])).toBe(0)
    expect(
      maxConcurrency([
        { startAt: '2026-10-26T14:00:00Z', endAt: '2026-10-26T16:00:00Z' },
        { startAt: '2026-10-26T16:00:00Z', endAt: '2026-10-26T18:00:00Z' }, // touches, no overlap
      ]),
    ).toBe(1)
    expect(
      maxConcurrency([
        { startAt: '2026-10-26T14:00:00Z', endAt: '2026-10-26T18:00:00Z' },
        { startAt: '2026-10-26T15:00:00Z', endAt: '2026-10-26T16:00:00Z' },
        { startAt: '2026-10-26T15:30:00Z', endAt: '2026-10-26T17:00:00Z' },
        { startAt: '2026-10-26T15:45:00Z', endAt: null },
      ]),
    ).toBe(3)
  })

  const overlappingPair = [
    historyItem('h-a', '2026-10-26T14:00:00Z', '2026-10-26T16:00:00Z'),
    historyItem('h-b', '2026-10-26T15:00:00Z', '2026-10-26T17:00:00Z'),
  ]

  it.each([
    ['crew size missing', null, overlappingPair, 1],
    ['declared crew 3, observed 1 (G23)', 3, [historyItem('h-a', NOW, '2026-11-02T07:00:00Z')], 1],
    ['declared crew 2, observed 2', 2, overlappingPair, 2],
    [
      'declared crew 2, observed 3',
      2,
      [...overlappingPair, historyItem('h-c', '2026-10-26T15:30:00Z', '2026-10-26T15:45:00Z')],
      2,
    ],
    ['declared crew 4, no history (minimum 1)', 4, [], 1],
  ])('D-041: capacity with %s', (_label, crewSize, history, expected) => {
    expect(crewCapacity(crewSize, history)).toBe(expected)
  })

  it('D-041: with capacity 2, time is open while fewer than 2 items are busy, at medium with a free-crew-lane reason', () => {
    // Mon: A 09-12, B 10-11, C 14-15 CST. Two busy 10-11 → closed; one busy elsewhere → open.
    const busy = [
      busyItem('job-a', '2026-11-02T15:00:00Z', '2026-11-02T18:00:00Z'),
      busyItem('job-b', '2026-11-02T16:00:00Z', '2026-11-02T17:00:00Z'),
      busyItem('job-c', '2026-11-02T20:00:00Z', '2026-11-02T21:00:00Z'),
    ]
    const result = computeAvailability(makeInput({ crewSize: 2, history: overlappingPair, busy }))

    expect(result.capacity).toBe(2)
    const monday = startingOn(result.openings, '2026-11-02')
    expect(spans(monday)).toEqual([
      '2026-11-02T14:00:00Z/2026-11-02T16:00:00Z',
      '2026-11-02T17:00:00Z/2026-11-02T23:00:00Z',
    ])
    monday.forEach((o) => {
      expect(o.confidence).toBe('medium')
      expect(o.reasons).toContain('free crew lane (1 of 2 busy)')
    })
    expect(monday[0]?.boundedBy).toEqual(expect.arrayContaining([ref('job-b')]))
    expect(monday[1]?.boundedBy).toEqual(expect.arrayContaining([ref('job-b')]))
  })

  it('D-041: with capacity 2, an opening that needs no free lane stays high', () => {
    const result = computeAvailability(makeInput({ crewSize: 2, history: overlappingPair }))

    expect(spans(result.openings)).toEqual([MON_FULL, TUE_FULL, WED_FULL])
    result.openings.forEach((o) => {
      expect(o.confidence).toBe('high')
      expect(o.reasons).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/free crew lane/)]),
      )
    })
  })

  it('G23/D-041: declared crew 3 with observed concurrency 1 is one schedule, at most medium with a reason', () => {
    const job = busyItem('job-1', MON_10_TO_12.start, MON_10_TO_12.end)
    const result = computeAvailability(makeInput({ crewSize: 3, busy: [job] }))

    expect(result.capacity).toBe(1)
    expect(spans(result.openings)).toEqual([...MON_WITH_10_TO_12_BOOKED, TUE_FULL, WED_FULL])
    result.openings.forEach((o) => {
      expect(o.confidence).toBe('medium')
      expect(o.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/crew/i)]))
      expect(o.reasons).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/free crew lane/)]),
      )
    })
  })
})

describe('D-041/R13 which items block', () => {
  function mondayWith(item: BusyItem) {
    const result = computeAvailability(makeInput({ busy: [item] }))
    return { result, monday: spans(startingOn(result.openings, '2026-11-02')) }
  }

  it.each<[string, BusyItem]>([
    ['a scheduled CRM job', busyItem('x', MON_10_TO_12.start, MON_10_TO_12.end)],
    [
      'an in-progress job',
      busyItem('x', MON_10_TO_12.start, MON_10_TO_12.end, { status: 'in_progress' }),
    ],
    [
      'an on-hold job with a slot',
      busyItem('x', MON_10_TO_12.start, MON_10_TO_12.end, { status: 'on_hold' }),
    ],
    [
      'a scheduled estimate (G4, D-017)',
      busyItem('x', MON_10_TO_12.start, MON_10_TO_12.end, { kind: 'estimate' }),
    ],
    [
      'an upcoming CRM A visit (G6)',
      busyItem('x', MON_10_TO_12.start, MON_10_TO_12.end, { kind: 'visit' }),
    ],
    [
      'a limbo job with a slot (G8)',
      busyItem('x', MON_10_TO_12.start, MON_10_TO_12.end, { status: 'limbo' }),
    ],
    ['a confirmed calendar event', calendarBlock('x', MON_10_TO_12.start, MON_10_TO_12.end)],
    [
      'a TENTATIVE calendar event (G17, D-022)',
      calendarBlock('x', MON_10_TO_12.start, MON_10_TO_12.end, { status: 'tentative' }),
    ],
    [
      'a low-confidence CSV-only future row (G18)',
      busyItem('x', MON_10_TO_12.start, MON_10_TO_12.end, {
        confidence: 'low',
        sources: [ref('row:12', 'spreadsheet')],
      }),
    ],
  ])('D-041: %s blocks its slot', (_label, item) => {
    expect(mondayWith(item).monday).toEqual(MON_WITH_10_TO_12_BOOKED)
  })

  it.each<[string, BusyItem]>([
    [
      'a cancelled job (G8)',
      busyItem('x', MON_10_TO_12.start, MON_10_TO_12.end, { status: 'cancelled' }),
    ],
    [
      'a cancelled CRM A visit (G6)',
      busyItem('x', MON_10_TO_12.start, MON_10_TO_12.end, { kind: 'visit', status: 'cancelled' }),
    ],
    [
      'a completed visit (G6)',
      busyItem('x', MON_10_TO_12.start, MON_10_TO_12.end, { kind: 'visit', status: 'completed' }),
    ],
    [
      'a "done" job dated after today (G10, D-022)',
      busyItem('x', MON_10_TO_12.start, MON_10_TO_12.end, {
        status: 'completed',
        sources: [ref('x', 'workiz')],
      }),
    ],
    [
      'a completed estimate',
      busyItem('x', MON_10_TO_12.start, MON_10_TO_12.end, {
        kind: 'estimate',
        status: 'completed',
      }),
    ],
    [
      'an unscheduled job with no start (G12)',
      busyItem('x', null, null, { status: 'unscheduled' }),
    ],
    ['an on-hold job with no slot (G12)', busyItem('x', null, null, { status: 'on_hold' })],
    [
      'a CXL calendar event (busy: false)',
      calendarBlock('x', MON_10_TO_12.start, MON_10_TO_12.end, { busy: false }),
    ],
    [
      'a TRANSPARENT calendar event (busy: false)',
      calendarBlock('x', MON_10_TO_12.start, MON_10_TO_12.end, { busy: false }),
    ],
    [
      'a cancelled calendar event',
      calendarBlock('x', MON_10_TO_12.start, MON_10_TO_12.end, { status: 'cancelled' }),
    ],
  ])('D-041: %s never blocks', (_label, item) => {
    const { result, monday } = mondayWith(item)

    expect(monday).toEqual([MON_FULL])
    expect(result.blocks).toEqual([])
  })

  it('G9: a rescheduled job blocks only its current slot, never the old date', () => {
    // Current slot Wed 10-12 CST; notes say it moved from Tue.
    const moved = busyItem('job-moved', '2026-11-04T16:00:00Z', '2026-11-04T18:00:00Z', {
      rescheduledFrom: '2026-11-03',
    })
    const { openings } = computeAvailability(makeInput({ busy: [moved] }))

    expect(spans(openings)).toEqual([
      MON_FULL,
      TUE_FULL,
      '2026-11-04T14:00:00Z/2026-11-04T16:00:00Z',
      '2026-11-04T18:00:00Z/2026-11-04T23:00:00Z',
    ])
  })
})

describe('D-041/D-022 low-confidence blocks', () => {
  const belowHigh = (o: { confidence: string }) => ['medium', 'low'].includes(o.confidence)

  it('G17/D-022: a TENTATIVE event blocks at low confidence and lowers that day with a reason', () => {
    const hold = calendarBlock('evt-hold', MON_10_TO_12.start, MON_10_TO_12.end, {
      status: 'tentative',
    })
    const result = computeAvailability(makeInput({ busy: [hold] }))

    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0]?.confidence).toBe('low')
    expect(result.blocks[0]?.reasons).toEqual(
      expect.arrayContaining([expect.stringMatching(/tentative/i)]),
    )
    const monday = startingOn(result.openings, '2026-11-02')
    monday.forEach((o) => {
      expect(belowHigh(o)).toBe(true)
      expect(o.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/tentative/i)]))
    })
    // Other days are unaffected.
    expect(startingOn(result.openings, '2026-11-03')[0]?.confidence).toBe('high')
  })

  it.each([
    ['limbo', /limbo/i],
    ['unscheduled', /unscheduled/i],
  ] as const)(
    'D-041/G12: a %s item with a start and no end blocks 1 h at low confidence',
    (status, statusReason) => {
      // Mon 10:00 CST, no end.
      const item = busyItem('job-open', MON_10_TO_12.start, null, { status })
      const result = computeAvailability(makeInput({ busy: [item] }))

      expect(spans(startingOn(result.openings, '2026-11-02'))).toEqual([
        '2026-11-02T14:00:00Z/2026-11-02T16:00:00Z',
        '2026-11-02T17:00:00Z/2026-11-02T23:00:00Z',
      ])
      expect(result.blocks).toHaveLength(1)
      const [block] = result.blocks
      expect(iso(block?.end ?? '')).toBe('2026-11-02T17:00:00Z')
      expect(block?.confidence).toBe('low')
      expect(block?.reasons).toEqual(
        expect.arrayContaining([
          expect.stringMatching(statusReason),
          expect.stringMatching(/no end|default duration/i),
        ]),
      )
      startingOn(result.openings, '2026-11-02').forEach((o) => {
        expect(belowHigh(o)).toBe(true)
      })
    },
  )

  it('G12: a scheduled job with no end gets the default duration with a reason', () => {
    const item = busyItem('job-noend', MON_10_TO_12.start, null)
    const result = computeAvailability(makeInput({ busy: [item] }))

    expect(iso(result.blocks[0]?.end ?? '')).toBe('2026-11-02T17:00:00Z')
    expect(result.blocks[0]?.reasons).toEqual(
      expect.arrayContaining([expect.stringMatching(/no end|default duration/i)]),
    )
  })

  it('G12: defaultDurationMinutes is configurable', () => {
    const item = busyItem('job-noend', MON_10_TO_12.start, null, { status: 'limbo' })
    const result = computeAvailability(makeInput({ busy: [item], defaultDurationMinutes: 90 }))

    expect(iso(result.blocks[0]?.end ?? '')).toBe('2026-11-02T17:30:00Z')
  })

  it('G18: a low-confidence CSV-only booking blocks at low confidence and cites its row', () => {
    const row = busyItem('row:12', MON_10_TO_12.start, MON_10_TO_12.end, {
      confidence: 'low',
      sources: [ref('row:12', 'spreadsheet')],
    })
    const result = computeAvailability(makeInput({ busy: [row] }))

    expect(result.blocks[0]?.confidence).toBe('low')
    expect(result.blocks[0]?.sources).toEqual([ref('row:12', 'spreadsheet')])
    expect(startingOn(result.openings, '2026-11-02')[0]?.boundedBy).toEqual([
      ref('row:12', 'spreadsheet'),
    ])
  })
})

describe('R13 minimum duration, Q2/Q4 helpers', () => {
  it('R13/Q2: minMinutes keeps gaps of exactly the minimum and drops shorter ones', () => {
    const busy = [
      busyItem('job-1', MON_10_TO_12.start, MON_10_TO_12.end), // leaves 08-10 (120 min)
      busyItem('job-2', '2026-11-02T19:59:00Z', '2026-11-02T23:00:00Z'), // leaves 12-13:59 (119)
    ]
    const { openings } = computeAvailability(makeInput({ busy, minMinutes: 120 }))

    expect(spans(openings)).toEqual([
      '2026-11-02T14:00:00Z/2026-11-02T16:00:00Z',
      TUE_FULL,
      WED_FULL,
    ])
  })

  it('Q4: nextOpenings returns the first n openings by start', () => {
    const job = busyItem('job-1', MON_10_TO_12.start, MON_10_TO_12.end)
    const { openings } = computeAvailability(makeInput({ busy: [job] }))

    expect(spans(nextOpenings(openings, 3))).toEqual([...MON_WITH_10_TO_12_BOOKED, TUE_FULL])
  })

  it('Q4: nextOpenings sorts its input and handles n beyond the list and n = 0', () => {
    const unsorted = [
      opening('2026-11-03T14:00:00Z', '2026-11-03T23:00:00Z'),
      opening('2026-11-02T14:00:00Z', '2026-11-02T23:00:00Z'),
    ]

    expect(spans(nextOpenings(unsorted, 5))).toEqual([MON_FULL, TUE_FULL])
    expect(nextOpenings(unsorted, 0)).toEqual([])
  })

  it('Q2: filterOpenings clips to the window and keeps openings of at least minMinutes', () => {
    const source = [
      opening('2026-11-02T14:00:00Z', '2026-11-02T16:00:00Z', { boundedBy: [ref('job-1')] }),
      opening('2026-11-02T18:00:00Z', '2026-11-02T23:00:00Z', {
        confidence: 'medium',
        reasons: ['free crew lane (1 of 2 busy)'],
      }),
      opening('2026-11-03T14:00:00Z', '2026-11-03T23:00:00Z'),
    ]
    const filtered = filterOpenings(source, {
      from: '2026-11-02T15:00:00Z',
      to: '2026-11-03T16:00:00Z',
      minMinutes: 120,
    })

    // Mon 14-16 clips to 60 min (dropped); Tue clips to 14-16, exactly 120 min (kept).
    expect(spans(filtered)).toEqual([
      '2026-11-02T18:00:00Z/2026-11-02T23:00:00Z',
      '2026-11-03T14:00:00Z/2026-11-03T16:00:00Z',
    ])
    expect(filtered.map((o) => o.minutes)).toEqual([300, 120])
    expect(filtered[0]?.confidence).toBe('medium')
    expect(filtered[0]?.reasons).toEqual(['free crew lane (1 of 2 busy)'])
  })
})

describe('R14 purity', () => {
  it('R14: computeAvailability is deterministic and does not mutate its input', () => {
    const input = makeInput({
      busy: [busyItem('job-1', MON_10_TO_12.start, MON_10_TO_12.end)],
    })
    const snapshot = structuredClone(input)

    expect(computeAvailability(input)).toEqual(computeAvailability(input))
    expect(input).toEqual(snapshot)
  })

  it('R14(a): src/availability never reads the system clock', () => {
    const dir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../src/availability',
    )
    ;['engine.ts', 'inferredHours.ts', 'confidence.ts'].forEach((file) => {
      const text = readFileSync(path.join(dir, file), 'utf8')
      expect(text).not.toMatch(/new Date\(\)|Date\.now\(\)|DateTime\.now\(\)/)
    })
  })
})
