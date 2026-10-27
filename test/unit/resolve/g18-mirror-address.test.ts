/*
 * G18: a calendar event mirrors a job only when nothing says they are at different homes. An
 * event at the same provider and time but a different known address is a separate booking.
 *
 * Expected API:
 *
 *   // src/adapters/types.ts
 *   export interface CalendarBlockCandidate {
 *     …
 *     // ICS LOCATION as a free-text address (RawAddress.freeText, ICS escapes removed); null or
 *     // absent when the event has no LOCATION. Server-only, like summaryRaw.
 *     location?: RawAddress | null
 *     // The property the location resolves to, keyed like PropertyCandidate.propertyKey so it can
 *     // be looked up in JobResolutionInput.propertyIdByKey; null or absent when unknown.
 *     propertyKey?: PropertyKey | null
 *   }
 *
 *   // src/resolve/jobs.ts: when the block's property and the job's property are both known and
 *   // differ, the block is not a mirror (timed or date-only). When both are known and equal, the
 *   // mirror link's evidence has addressAgrees: true. Unknown on either side → D-021 (time only).
 *
 * The ICS adapter emits no property candidates (existing test); the pipeline derives the block's
 * property from `location`.
 */
import { describe, expect, it } from 'vitest'
import { icsAdapter } from '../../../src/adapters/ics.ts'
import type { CalendarBlockCandidate } from '../../../src/adapters/types.ts'
import { resolveJobs, type JobInput, type JobResolution } from '../../../src/resolve/jobs.ts'
import { loadFixtureFiles, makeCtx, one } from '../adapters/support.ts'
import { field } from '../pending.ts'
import { block, job } from './support.ts'

const PROVIDERS = new Map([
  ['spreadsheet:dots_fixit_job_log', 'prov-dot'],
  ['ics:dots_calendar', 'prov-dot'],
])

const PROPERTIES = new Map([
  ['spreadsheet:dots_fixit_job_log:addr-1', 'home-liveoak'],
  ['ics:dots_calendar:loc-liveoak', 'home-liveoak'],
  ['ics:dots_calendar:loc-belmont', 'home-belmont'],
])

function resolve(
  jobs: readonly JobInput[],
  calendarBlocks: readonly CalendarBlockCandidate[],
): JobResolution {
  return resolveJobs({
    jobs,
    calendarBlocks,
    providerIdByKey: PROVIDERS,
    propertyIdByKey: PROPERTIES,
  })
}

/** Tue 2026-11-03 13:00 local at the Live Oak home. */
const row = job('spreadsheet', 'dots_fixit_job_log', 'row:40', {
  propertyKey: 'spreadsheet:dots_fixit_job_log:addr-1',
  startAt: '2026-11-03T19:00:00Z',
  timeBasis: 'local_assumed',
  tradeRaw: 'fence boards',
})

/** A work event 10 minutes later, at the given location property. */
function eventAt(propertyKey: string | null, uid = 'evt-40') {
  // A variable, not a literal, so the new field type-checks before the adapter type declares it.
  const event = {
    ...block('dots_calendar', uid, '2026-11-03T19:10:00Z', '2026-11-03T21:00:00Z', {
      summaryRaw: 'fence boards',
      timeBasis: 'local_assumed',
    }),
    propertyKey,
  }
  return event
}

describe('G18: calendar mirrors need a compatible address', () => {
  it('G18: an event at the same time but a different known address is not a mirror', () => {
    const resolution = resolve([row], [eventAt('ics:dots_calendar:loc-belmont')])

    expect(resolution.jobs).toHaveLength(1)
    expect(resolution.jobs[0]?.links).toHaveLength(1)
    expect(resolution.mirroredBlocks).toEqual([])
  })

  it('G18: an event at the same known address mirrors, with addressAgrees in the evidence', () => {
    const resolution = resolve([row], [eventAt('ics:dots_calendar:loc-liveoak')])

    expect(resolution.mirroredBlocks).toHaveLength(1)
    const mirror = resolution.jobs[0]?.links.find((l) => l.method === 'calendar_mirror')
    expect(mirror?.confidence).toBe(0.8)
    expect(mirror?.evidence).toMatchObject({ minutesApart: 10, addressAgrees: true })
  })

  it('G18/D-021: an event with no known address still mirrors on time alone', () => {
    const resolution = resolve([row], [eventAt(null)])

    expect(resolution.mirroredBlocks).toHaveLength(1)
  })

  it('G18: the nearest same-address event wins over a nearer different-address one', () => {
    const elsewhere = {
      ...block('dots_calendar', 'evt-41', '2026-11-03T19:00:00Z', '2026-11-03T20:00:00Z'),
      propertyKey: 'ics:dots_calendar:loc-belmont',
    }
    const resolution = resolve([row], [elsewhere, eventAt('ics:dots_calendar:loc-liveoak')])

    expect(resolution.mirroredBlocks.map((m) => m.blockRef.sourceRecordId)).toEqual([
      'evt-40@2026-11-03T19:10:00Z',
    ])
  })

  it('G18: a date-only row does not take the time of a same-day event at another address', () => {
    const dateOnly = job('spreadsheet', 'dots_fixit_job_log', 'row:41', {
      propertyKey: 'spreadsheet:dots_fixit_job_log:addr-1',
      startAt: '2026-11-03T06:00:00Z', // local midnight
      allDay: true,
      timeBasis: 'date_only',
      tradeRaw: 'fence boards',
    })
    const resolution = resolve([dateOnly], [eventAt('ics:dots_calendar:loc-belmont')])

    expect(resolution.jobs[0]).toMatchObject({ allDay: true, startAt: '2026-11-03T06:00:00Z' })
    expect(resolution.mirroredBlocks).toEqual([])
  })
})

describe('G18: the ICS adapter keeps the event location', () => {
  const blocks = icsAdapter.parse(loadFixtureFiles('calendars'), makeCtx()).calendarBlocks
  const byUid = (uid: string) => one(blocks, (b) => b.ref.sourceRecordId.startsWith(`${uid}@`))

  it('G18: LOCATION becomes a free-text address with ICS escapes removed', () => {
    expect(field(byUid('tzid-job-1'), 'location')).toEqual({
      line1: null,
      line2: null,
      city: null,
      state: null,
      zip: null,
      freeText: '4526 Live Oak St, Dallas, TX 75204',
    })
  })

  it('G18: an event without LOCATION has a null location', () => {
    expect(field(byUid('dentist-7'), 'location')).toBeNull()
  })
})
