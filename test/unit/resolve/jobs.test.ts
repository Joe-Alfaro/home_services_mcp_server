import { describe, expect, it } from 'vitest'
import type { CalendarBlockCandidate } from '../../../src/adapters/types.ts'
import {
  CROSS_SOURCE_TOLERANCE_MINUTES,
  JOB_CONFIDENCE,
  resolveJobs,
  type JobInput,
  type JobResolution,
  type ResolvedJob,
} from '../../../src/resolve/jobs.ts'
import { block, job, refId } from './support.ts'

/*
 * API pinned for src/resolve/jobs.ts (ARCHITECTURE "Resolution methods", R8, D-017, D-021,
 * G5, G6, G16, G17, G18):
 *
 * // CRM B jobs carry the native ID of the estimate they came from (original_estimate_id).
 * export type JobInput = JobCandidate & { originalEstimateRecordId?: string | null }
 * export type JobMatchMethod =
 *   'single_source' | 'duplicate_row' | 'cross_source_time' | 'estimate_to_job' | 'calendar_mirror'
 * export const JOB_CONFIDENCE: Readonly<Record<JobMatchMethod, number>>
 *   // single_source 1, duplicate_row 0.95, cross_source_time 0.8, estimate_to_job 1, calendar_mirror 0.8
 * export const CROSS_SOURCE_TOLERANCE_MINUTES = 30 // inclusive
 * export interface JobLink {
 *   ref: SourceRef
 *   method: JobMatchMethod
 *   confidence: number
 *   evidence: Record<string, unknown> // cross-source links include minutesApart
 * }
 * export interface ResolvedJob {
 *   id: string
 *   providerId: string
 *   propertyId: string | null
 *   parentJobId: string | null   // CRM A visits → the id of their parent job
 *   kind: JobKind
 *   status: JobStatus
 *   startAt: Instant | null
 *   endAt: Instant | null
 *   allDay: boolean
 *   timeBasis: TimeBasis | null
 *   tradeRaw: string | null
 *   amountCents: number | null
 *   duplicateCount: number       // source rows collapsed into this job (1 when none)
 *   confidence: number           // the lowest link confidence
 *   links: JobLink[]             // one per source record, calendar blocks included
 * }
 * export interface JobResolutionInput {
 *   jobs: readonly JobInput[]
 *   calendarBlocks: readonly CalendarBlockCandidate[]
 *   providerIdByKey: ReadonlyMap<ProviderKey, string>   // from resolveProviders
 *   propertyIdByKey: ReadonlyMap<PropertyKey, string>   // from resolveProperties
 * }
 * export interface JobResolution {
 *   jobs: ResolvedJob[]
 *   // Calendar blocks that mirror a job; the block stays a calendar block, linked to the job.
 *   mirroredBlocks: Array<{ blockRef: SourceRef; jobId: string; confidence: number }>
 * }
 * export function resolveJobs(input: JobResolutionInput): JobResolution
 *
 * Rules pinned here: CSV rows identical after normalization (date, time, property, job text
 * ignoring case and spacing, amount) collapse into one job. Jobs from different source accounts
 * with the same canonical provider and property starting within 30 minutes merge. A busy work
 * calendar block of the same provider starting within 30 minutes of a job mirrors it (no property
 * needed, D-021); disagreeing job text lowers the confidence. A date-only CSV row takes the time of
 * the provider's single work block that local day. Jobs from one source account never merge by time.
 */

const PROVIDERS = new Map([
  ['workiz:acme_plumbing', 'prov-acme'],
  ['housecall_pro:acme_plumbing_co_llc', 'prov-acme'],
  ['jobber:wren_electric', 'prov-wren'],
  ['ics:wren_calendar', 'prov-wren'],
  ['spreadsheet:dots_fixit_job_log', 'prov-dot'],
  ['ics:dots_calendar', 'prov-dot'],
  ['jobber:kestrel_home_repair', 'prov-kestrel'],
])

const PROPERTIES = new Map([
  ['workiz:acme_plumbing:C1', 'home-belmont'],
  ['housecall_pro:acme_plumbing_co_llc:cus_1', 'home-belmont'],
  ['housecall_pro:acme_plumbing_co_llc:cus_2', 'home-juniper'],
  ['jobber:kestrel_home_repair:P1', 'home-belmont'],
  ['jobber:wren_electric:P1', 'home-liveoak'],
  ['spreadsheet:dots_fixit_job_log:addr-1', 'home-liveoak'],
  ['spreadsheet:dots_fixit_job_log:addr-1b', 'home-liveoak'],
  ['spreadsheet:dots_fixit_job_log:addr-2', 'home-belmont'],
])

function resolve(
  jobs: readonly JobInput[],
  calendarBlocks: readonly CalendarBlockCandidate[] = [],
): JobResolution {
  return resolveJobs({
    jobs,
    calendarBlocks,
    providerIdByKey: PROVIDERS,
    propertyIdByKey: PROPERTIES,
  })
}

function jobWith(resolution: JobResolution, sourceRecordId: string): ResolvedJob {
  const found = resolution.jobs.filter((j) =>
    j.links.some((l) => l.ref.sourceRecordId === sourceRecordId),
  )
  expect(found).toHaveLength(1)
  const [one] = found
  if (one === undefined) throw new Error(`no job for ${sourceRecordId}`)
  return one
}

function csvRow(row: number, fields: Parameters<typeof job>[3] = {}) {
  return job('spreadsheet', 'dots_fixit_job_log', `row:${String(row)}`, {
    propertyKey: 'spreadsheet:dots_fixit_job_log:addr-1',
    startAt: '2026-11-03T19:00:00Z', // 13:00 local
    timeBasis: 'local_assumed',
    tradeRaw: 'fence boards',
    amountCents: 14500,
    ...fields,
  })
}

describe('JOB_CONFIDENCE (R8 (c))', () => {
  it('pins the confidence of every tier and the 30-minute tolerance (D-021)', () => {
    expect(JOB_CONFIDENCE).toEqual({
      single_source: 1,
      duplicate_row: 0.95,
      cross_source_time: 0.8,
      estimate_to_job: 1,
      calendar_mirror: 0.8,
    })
    expect(CROSS_SOURCE_TOLERANCE_MINUTES).toBe(30)
  })
})

describe('single-source jobs', () => {
  it('a job in one source links with method single_source at confidence 1', () => {
    const resolution = resolve([csvRow(4)])
    expect(resolution.jobs).toHaveLength(1)
    const [only] = resolution.jobs
    expect(only).toMatchObject({
      providerId: 'prov-dot',
      propertyId: 'home-liveoak',
      duplicateCount: 1,
      confidence: 1,
      links: [expect.objectContaining({ method: 'single_source', confidence: 1 })],
    })
  })
})

describe('G16: duplicate CSV rows', () => {
  it('collapses two identical rows into one job with duplicate_count 2 at 0.95', () => {
    const resolution = resolve([csvRow(5), csvRow(6)])
    expect(resolution.jobs).toHaveLength(1)
    const merged = jobWith(resolution, 'row:5')
    expect(merged.duplicateCount).toBe(2)
    expect(merged.confidence).toBe(0.95)
    expect(merged.links.map((l) => l.ref.sourceRecordId).sort()).toEqual(['row:5', 'row:6'])
    expect(merged.links.map((l) => l.method)).toContain('duplicate_row')
  })

  it('treats job text that differs only in case and spacing as identical', () => {
    expect(resolve([csvRow(5), csvRow(6, { tradeRaw: '  Fence  Boards ' })]).jobs).toHaveLength(1)
  })

  it('treats two spellings of the same home as the same address', () => {
    const rows = [csvRow(5), csvRow(6, { propertyKey: 'spreadsheet:dots_fixit_job_log:addr-1b' })]
    expect(resolve(rows).jobs).toHaveLength(1)
  })

  it('keeps rows that differ in amount, date or home', () => {
    expect(resolve([csvRow(5), csvRow(6, { amountCents: 9500 })]).jobs).toHaveLength(2)
    expect(resolve([csvRow(5), csvRow(6, { startAt: '2026-11-04T19:00:00Z' })]).jobs).toHaveLength(
      2,
    )
    expect(
      resolve([csvRow(5), csvRow(6, { propertyKey: 'spreadsheet:dots_fixit_job_log:addr-2' })])
        .jobs,
    ).toHaveLength(2)
  })

  it('keeps the same job on two dates noted "2nd trip" as two jobs', () => {
    const rows = [
      csvRow(7, { startAt: '2026-10-20T15:00:00Z', notesRaw: null }),
      csvRow(8, { startAt: '2026-10-22T15:00:00Z', notesRaw: '2nd trip' }),
    ]
    expect(resolve(rows).jobs).toHaveLength(2)
  })
})

describe('cross-source CRM jobs (R8, ARCHITECTURE job tier)', () => {
  const workiz = job('workiz', 'acme_plumbing', 'W1', {
    propertyKey: 'workiz:acme_plumbing:C1',
    startAt: '2026-11-04T15:00:00Z',
    tradeRaw: 'WH replace',
  })

  function hcpAt(startAt: string, propertyKey = 'housecall_pro:acme_plumbing_co_llc:cus_1') {
    return job('housecall_pro', 'acme_plumbing_co_llc', 'job_1', {
      propertyKey,
      startAt,
      tradeRaw: 'Water heater replacement',
    })
  }

  it('merges the same provider, home and start within 30 minutes at 0.8', () => {
    const resolution = resolve([workiz, hcpAt('2026-11-04T15:20:00Z')])
    expect(resolution.jobs).toHaveLength(1)
    const merged = jobWith(resolution, 'W1')
    expect(merged.confidence).toBe(0.8)
    expect(merged.links.map((l) => refId(l.ref)).sort()).toEqual([
      'housecall_pro:job_1',
      'workiz:W1',
    ])
    expect(merged.links.find((l) => l.method === 'cross_source_time')).toMatchObject({
      confidence: 0.8,
      evidence: { minutesApart: 20 },
    })
  })

  it('the 30-minute tolerance is inclusive', () => {
    expect(resolve([workiz, hcpAt('2026-11-04T15:30:00Z')]).jobs).toHaveLength(1)
  })

  it('does not merge starts 31 minutes apart', () => {
    expect(resolve([workiz, hcpAt('2026-11-04T15:31:00Z')]).jobs).toHaveLength(2)
  })

  it('does not merge jobs at different homes', () => {
    const resolution = resolve([
      workiz,
      hcpAt('2026-11-04T15:00:00Z', 'housecall_pro:acme_plumbing_co_llc:cus_2'),
    ])
    expect(resolution.jobs).toHaveLength(2)
  })

  it('does not merge different providers at the same home and time', () => {
    const other = job('jobber', 'kestrel_home_repair', 'K1', {
      propertyKey: 'jobber:kestrel_home_repair:P1',
      startAt: '2026-11-04T15:00:00Z',
    })
    expect(resolve([workiz, other]).jobs).toHaveLength(2)
  })

  it('never merges two records of one source account by time', () => {
    const second = job('workiz', 'acme_plumbing', 'W2', {
      propertyKey: 'workiz:acme_plumbing:C1',
      startAt: '2026-11-04T15:10:00Z',
      tradeRaw: 'WH replace',
    })
    expect(resolve([workiz, second]).jobs).toHaveLength(2)
  })

  it('does not merge undated jobs', () => {
    const a = job('workiz', 'acme_plumbing', 'W3', { propertyKey: 'workiz:acme_plumbing:C1' })
    const b = job('housecall_pro', 'acme_plumbing_co_llc', 'job_3', {
      propertyKey: 'housecall_pro:acme_plumbing_co_llc:cus_1',
    })
    expect(resolve([a, b]).jobs).toHaveLength(2)
  })
})

describe('G5, D-017: an approved estimate and its job count once', () => {
  const estimate = job('housecall_pro', 'acme_plumbing_co_llc', 'est_1', {
    kind: 'estimate',
    status: 'completed',
    statusRaw: 'complete rated',
    propertyKey: 'housecall_pro:acme_plumbing_co_llc:cus_1',
    startAt: '2026-09-01T14:00:00Z',
    tradeRaw: 'Water heater replacement - estimate',
  })
  const fromEstimate: JobInput = {
    ...job('housecall_pro', 'acme_plumbing_co_llc', 'job_9', {
      status: 'completed',
      statusRaw: 'complete rated',
      propertyKey: 'housecall_pro:acme_plumbing_co_llc:cus_1',
      startAt: '2026-09-08T14:00:00Z',
      tradeRaw: 'Water heater replacement',
    }),
    originalEstimateRecordId: 'est_1',
  }

  it('folds the estimate into the job: one job whose sources include the estimate', () => {
    const resolution = resolve([estimate, fromEstimate])
    expect(resolution.jobs).toHaveLength(1)
    const merged = jobWith(resolution, 'job_9')
    expect(merged.kind).toBe('job')
    expect(merged.startAt).toBe('2026-09-08T14:00:00Z')
    expect(merged.links.find((l) => l.ref.sourceRecordId === 'est_1')).toMatchObject({
      method: 'estimate_to_job',
      confidence: 1,
    })
    expect(resolution.jobs.filter((j) => j.kind === 'estimate')).toEqual([])
  })

  it('keeps an estimate no job points to as a separate estimate', () => {
    const lone = job('housecall_pro', 'acme_plumbing_co_llc', 'est_2', {
      kind: 'estimate',
      propertyKey: 'housecall_pro:acme_plumbing_co_llc:cus_1',
      startAt: '2026-11-05T15:00:00Z',
    })
    const resolution = resolve([estimate, fromEstimate, lone])
    expect(resolution.jobs).toHaveLength(2)
    expect(jobWith(resolution, 'est_2').kind).toBe('estimate')
  })

  it('only links an estimate from the same source account', () => {
    const elsewhere: JobInput = {
      ...job('workiz', 'acme_plumbing', 'W9', {
        propertyKey: 'workiz:acme_plumbing:C1',
        startAt: '2026-10-01T14:00:00Z',
      }),
      originalEstimateRecordId: 'est_1',
    }
    const resolution = resolve([estimate, elsewhere])
    expect(resolution.jobs).toHaveLength(2)
    expect(jobWith(resolution, 'est_1').kind).toBe('estimate')
  })
})

describe('G6: CRM A visits stay separate rows under their parent', () => {
  it('links each visit to the parent job and never merges visits with each other', () => {
    const parent = job('jobber', 'wren_electric', 'J9', {
      propertyKey: 'jobber:wren_electric:P1',
      isRecurring: true,
      startAt: null,
    })
    const visits = ['V1', 'V2'].map((id, i) =>
      job('jobber', 'wren_electric', id, {
        kind: 'visit',
        parentSourceRecordId: 'J9',
        propertyKey: 'jobber:wren_electric:P1',
        startAt: `2026-11-1${String(i)}T15:00:00Z`,
      }),
    )
    const resolution = resolve([parent, ...visits])
    expect(resolution.jobs).toHaveLength(3)
    const parentId = jobWith(resolution, 'J9').id
    expect(jobWith(resolution, 'V1').parentJobId).toBe(parentId)
    expect(jobWith(resolution, 'V2').parentJobId).toBe(parentId)
    expect(jobWith(resolution, 'J9').parentJobId).toBeNull()
  })
})

describe('G17, G18, D-021: calendar events that mirror jobs', () => {
  const crmJob = job('jobber', 'wren_electric', 'J1', {
    kind: 'visit',
    propertyKey: 'jobber:wren_electric:P1',
    startAt: '2026-11-12T15:00:00Z',
    endAt: '2026-11-12T17:00:00Z',
    timeBasis: 'utc',
    tradeRaw: 'Install ceiling fan',
  })

  it('a work event at the same provider and start as a CRM job is one booking with two sources', () => {
    const event = block('wren_calendar', 'evt-1', '2026-11-12T15:00:00Z', '2026-11-12T17:00:00Z', {
      summaryRaw: 'install ceiling fan',
    })
    const resolution = resolve([crmJob], [event])
    expect(resolution.jobs).toHaveLength(1)
    const booking = jobWith(resolution, 'J1')
    expect(booking.links.map((l) => refId(l.ref)).sort()).toEqual([
      'ics:evt-1@2026-11-12T15:00:00Z',
      'jobber:J1',
    ])
    expect(booking.links).toContainEqual(
      expect.objectContaining({ method: 'calendar_mirror', confidence: 0.8 }),
    )
    expect(resolution.mirroredBlocks).toEqual([
      { blockRef: event.ref, jobId: booking.id, confidence: 0.8 },
    ])
  })

  it('a CSV row and a calendar event within 30 minutes merge without an address, with lower confidence when the text disagrees', () => {
    const row = csvRow(20, { tradeRaw: 'fence boards' })
    const event = block('dots_calendar', 'evt-2', '2026-11-03T19:15:00Z', '2026-11-03T21:00:00Z', {
      summaryRaw: 'gate fix',
      timeBasis: 'local_assumed',
    })
    const resolution = resolve([row], [event])
    expect(resolution.jobs).toHaveLength(1)
    const booking = jobWith(resolution, 'row:20')
    expect(booking.links).toHaveLength(2)
    expect(booking.confidence).toBeLessThan(0.8)
    expect(booking.confidence).toBeGreaterThan(0)
    expect(resolution.mirroredBlocks).toHaveLength(1)
  })

  it('does not mirror an event more than 30 minutes away', () => {
    const event = block('wren_calendar', 'evt-3', '2026-11-12T15:45:00Z', '2026-11-12T17:00:00Z')
    const resolution = resolve([crmJob], [event])
    expect(jobWith(resolution, 'J1').links).toHaveLength(1)
    expect(resolution.mirroredBlocks).toEqual([])
  })

  it('does not mirror a personal event or another provider’s event', () => {
    const personal = block(
      'wren_calendar',
      'evt-4',
      '2026-11-12T15:00:00Z',
      '2026-11-12T16:00:00Z',
      {
        category: 'personal',
      },
    )
    const otherProvider = block(
      'dots_calendar',
      'evt-5',
      '2026-11-12T15:00:00Z',
      '2026-11-12T17:00:00Z',
    )
    const resolution = resolve([crmJob], [personal, otherProvider])
    expect(jobWith(resolution, 'J1').links).toHaveLength(1)
    expect(resolution.mirroredBlocks).toEqual([])
  })

  it('a calendar-only event stays a calendar block, not a job', () => {
    const event = block('dots_calendar', 'evt-6', '2026-11-20T15:00:00Z', '2026-11-20T17:00:00Z')
    const resolution = resolve([], [event])
    expect(resolution.jobs).toEqual([])
    expect(resolution.mirroredBlocks).toEqual([])
  })

  it('a date-only CSV row takes the time of the provider’s single work event that local day', () => {
    const row = csvRow(30, {
      startAt: '2026-11-10T06:00:00Z', // local midnight, 2026-11-10 CST
      endAt: null,
      allDay: true,
      timeBasis: 'date_only',
      tradeRaw: 'tv mount',
    })
    const event = block('dots_calendar', 'evt-7', '2026-11-10T17:00:00Z', '2026-11-10T19:00:00Z', {
      summaryRaw: 'TV mount',
      timeBasis: 'local_assumed',
    })
    const resolution = resolve([row], [event])
    expect(resolution.jobs).toHaveLength(1)
    expect(jobWith(resolution, 'row:30')).toMatchObject({
      startAt: '2026-11-10T17:00:00Z',
      endAt: '2026-11-10T19:00:00Z',
      allDay: false,
    })
    expect(resolution.mirroredBlocks).toHaveLength(1)
  })

  it('a date-only CSV row stays date-only when that day has two work events', () => {
    const row = csvRow(31, {
      startAt: '2026-11-10T06:00:00Z',
      endAt: null,
      allDay: true,
      timeBasis: 'date_only',
    })
    const events = [
      block('dots_calendar', 'evt-8', '2026-11-10T15:00:00Z', '2026-11-10T16:00:00Z'),
      block('dots_calendar', 'evt-9', '2026-11-10T19:00:00Z', '2026-11-10T20:00:00Z'),
    ]
    const resolution = resolve([row], events)
    expect(jobWith(resolution, 'row:31')).toMatchObject({ allDay: true })
    expect(resolution.mirroredBlocks).toEqual([])
  })
})

describe('R8 (a): every job link is scored', () => {
  it('every link has a method, a confidence in [0, 1] and an evidence object', () => {
    const resolution = resolve(
      [csvRow(5), csvRow(6), job('workiz', 'acme_plumbing', 'W1', { startAt: null })],
      [block('dots_calendar', 'evt-1', '2026-11-03T19:00:00Z', '2026-11-03T21:00:00Z')],
    )
    const links = resolution.jobs.flatMap((j) => j.links)
    expect(links.length).toBeGreaterThan(0)
    links.forEach((link) => {
      expect(link.method).toEqual(expect.any(String))
      expect(link.confidence).toBeGreaterThanOrEqual(0)
      expect(link.confidence).toBeLessThanOrEqual(1)
      expect(link.evidence).toEqual(expect.any(Object))
    })
  })
})
