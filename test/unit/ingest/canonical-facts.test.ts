/*
 * Facts the adapters and engine already compute must survive into the canonical rows, because the
 * MCP layer reads only the canonical tables through the read views (G9, G17, G18, G20, R8 c).
 *
 * Expected API (src/ingest/canonical.ts):
 *
 *   export interface JobRow {
 *     …
 *     // G9: JobCandidate.rescheduledFrom, a local date "YYYY-MM-DD"; null when not rescheduled.
 *     rescheduledFrom: string | null
 *   }
 *   export interface CalendarBlockRow {
 *     …
 *     // G17: CalendarBlockCandidate.status; a missing status is 'confirmed'.
 *     status: 'confirmed' | 'tentative' | 'cancelled'
 *   }
 *   export interface DeclaredHoursRow {
 *     …
 *     // G20: DeclaredHoursCandidate.alwaysOpen; false when absent.
 *     alwaysOpen: boolean
 *   }
 *
 *   // R8 (c): a job record belongs to its account by construction, so the account_record tier is
 *   // certain on its own; the provider_links row carries ACCOUNT_RECORD_CONFIDENCE times the
 *   // account's own match confidence, and its evidence names both.
 *   export const ACCOUNT_RECORD_CONFIDENCE = 1
 *   // account_record evidence: { providerKey, accountMethod, accountConfidence }
 *
 *   // G18: a calendar LOCATION and a job address with the same house number, street and unit are
 *   // the same address even when only one side has a zip (or city), so the block still mirrors the
 *   // job. Only a genuinely different address refuses the mirror.
 *
 * All names, phones and addresses are invented.
 */
import { describe, expect, it } from 'vitest'
import type {
  CandidateBatch,
  DeclaredHoursCandidate,
  JobCandidate,
} from '../../../src/adapters/types.ts'
import * as canonicalModule from '../../../src/ingest/canonical.ts'
import { ACCOUNT_RECORD_METHOD, buildCanonical } from '../../../src/ingest/canonical.ts'
import { PROVIDER_CONFIDENCE } from '../../../src/resolve/providers.ts'
import { freeText, referenceIndex, structured } from '../normalize/reference.ts'
import { field } from '../pending.ts'
import { block, job, property, provider, ref } from '../resolve/support.ts'

const LOG = 'wrenfield_air_job_log'
const CALENDAR = 'wrenfield_calendar'
const CRM = 'wrenfield_air'

function batch(fields: Partial<CandidateBatch>): CandidateBatch {
  return {
    providers: [],
    properties: [],
    jobs: [],
    calendarBlocks: [],
    declaredHours: [],
    issues: [],
    ...fields,
  }
}

function hours(alwaysOpen: boolean | undefined): DeclaredHoursCandidate {
  return {
    type: 'declared_hours',
    ref: ref('profiles', 'providers', 'hp_910', 'sources/profiles/providers.json'),
    providerKey: 'profiles:hp_910',
    hoursRaw: alwaysOpen === true ? 'Open 24/7' : 'Mon-Fri 8am-5pm',
    weekly:
      alwaysOpen === true
        ? ([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({
            weekday,
            start: '00:00',
            end: '24:00',
          }))
        : ([1, 2, 3, 4, 5] as const).map((weekday) => ({ weekday, start: '08:00', end: '17:00' })),
    parsed: 'full',
    ...(alwaysOpen === undefined ? {} : { alwaysOpen }),
  }
}

const profile = provider('profiles', 'hp_910', {
  businessName: 'Wrenfield Air',
  ownerName: 'Tamsin Example',
  phones: ['2145550177'],
  tradesRaw: ['hvac'],
})
const crmAccount = provider('jobber', CRM, {
  businessName: 'Wrenfield Air',
  phones: ['214-555-0177'],
  tradesRaw: ['hvac'],
})
const logAccount = provider('spreadsheet', LOG, { businessName: 'Wrenfield Air' })
const calendarAccount = provider('ics', CALENDAR, { businessName: 'Tamsin Example (work)' })

/** Thu 2026-11-05 09:00 local, no zip in the log (out-of-reference street). */
const quinceRow: JobCandidate = job('spreadsheet', LOG, 'row:4', {
  propertyKey: `spreadsheet:${LOG}:row:4`,
  startAt: '2026-11-05T15:00:00Z',
  timeBasis: 'local_assumed',
  tradeRaw: 'furnace tune-up',
})
/** Fri 2026-11-06 10:00 local at a known reference address. */
const sampleRow: JobCandidate = job('spreadsheet', LOG, 'row:5', {
  propertyKey: `spreadsheet:${LOG}:row:5`,
  startAt: '2026-11-06T16:00:00Z',
  timeBasis: 'local_assumed',
  tradeRaw: 'duct cleaning',
})
/** Fri 2026-11-06 15:00 local, moved from Tuesday 11/3. */
const movedRow: JobCandidate = job('spreadsheet', LOG, 'row:6', {
  propertyKey: `spreadsheet:${LOG}:row:6`,
  startAt: '2026-11-06T21:00:00Z',
  timeBasis: 'local_assumed',
  tradeRaw: 'thermostat swap',
  notesRaw: 'Rescheduled from 11/3',
  rescheduleNote: 'Rescheduled from 11/3',
  rescheduledFrom: '2026-11-03',
})
const crmJob: JobCandidate = job('jobber', CRM, 'job-wf-01', {
  status: 'completed',
  startAt: '2026-10-20T14:00:00Z',
  endAt: '2026-10-20T16:00:00Z',
  timeBasis: 'utc',
})

const quinceEvent = block(
  CALENDAR,
  'job-quince-1',
  '2026-11-05T15:00:00Z',
  '2026-11-05T17:00:00Z',
  {
    summaryRaw: 'Job - furnace tune-up (77 quince ln)',
    location: freeText('77 Quince Ln, Plano, TX 75093'),
    status: 'confirmed',
  },
)
const sampleEvent = block(
  CALENDAR,
  'job-sample-2',
  '2026-11-06T16:00:00Z',
  '2026-11-06T17:30:00Z',
  {
    summaryRaw: 'Job - duct cleaning (1250 sample ave)',
    location: freeText('1250 Sample Ave, Dallas, TX 75214'),
    status: 'confirmed',
  },
)
const tentativeHold = block(CALENDAR, 'hold-3', '2026-11-04T16:00:00Z', '2026-11-04T18:00:00Z', {
  summaryRaw: 'Hold: possible furnace check',
  category: 'unknown',
  status: 'tentative',
})

function model(alwaysOpen?: boolean) {
  return buildCanonical(
    [
      batch({
        providers: [profile],
        declaredHours: [hours(alwaysOpen)],
      }),
      batch({ providers: [crmAccount], jobs: [crmJob] }),
      batch({
        providers: [logAccount],
        properties: [
          property('spreadsheet', LOG, 'row:4', freeText('77 Quince Ln')),
          property('spreadsheet', LOG, 'row:5', freeText('1240 Sample Ave')),
          property('spreadsheet', LOG, 'row:6', structured('1265 Sample Ave', { zip: '75214' })),
        ],
        jobs: [quinceRow, sampleRow, movedRow],
      }),
      batch({
        providers: [calendarAccount],
        calendarBlocks: [quinceEvent, sampleEvent, tentativeHold],
      }),
    ],
    referenceIndex(),
  )
}

function jobOf(canonical: ReturnType<typeof model>, sourceRecordId: string) {
  const link = canonical.jobLinks.find((l) => l.record.endsWith(`|${sourceRecordId}|job`))
  return canonical.jobs.find((j) => j.id === link?.entityId)
}

function blockOf(canonical: ReturnType<typeof model>, uid: string) {
  return canonical.calendarBlocks.find((b) => b.record.includes(`${uid}@`))
}

describe('fixture sanity', () => {
  it('resolves the profile, CRM account, log and calendar to one provider', () => {
    expect(model().providers).toHaveLength(1)
  })

  it('finds every job and block by its source record', () => {
    const canonical = model()
    ;['row:4', 'row:5', 'row:6', 'job-wf-01'].forEach((id) => {
      expect(jobOf(canonical, id), id).toBeDefined()
    })
    ;['job-quince-1', 'job-sample-2', 'hold-3'].forEach((uid) => {
      expect(blockOf(canonical, uid), uid).toBeDefined()
    })
  })
})

describe('G9: rescheduled_from reaches the canonical job', () => {
  it('G9: the moved row keeps the local date it moved from', () => {
    expect(field(jobOf(model(), 'row:6') ?? {}, 'rescheduledFrom')).toBe('2026-11-03')
  })

  it('G9: a job that was not rescheduled has rescheduledFrom null', () => {
    expect(field(jobOf(model(), 'row:5') ?? {}, 'rescheduledFrom')).toBeNull()
  })
})

describe('G17: the ICS status reaches the canonical block', () => {
  it('G17: a TENTATIVE event is persisted as tentative', () => {
    expect(field(blockOf(model(), 'hold-3') ?? {}, 'status')).toBe('tentative')
  })

  it('G17: a CONFIRMED event is persisted as confirmed', () => {
    expect(field(blockOf(model(), 'job-sample-2') ?? {}, 'status')).toBe('confirmed')
  })
})

describe('G20: the 24/7 flag reaches the canonical declared hours', () => {
  it('G20: every hours row of an always-open profile has alwaysOpen true', () => {
    const rows = model(true).declaredHours
    expect(rows.length).toBeGreaterThan(0)
    rows.forEach((row) => {
      expect(field(row, 'alwaysOpen')).toBe(true)
    })
  })

  it('G20: ordinary hours have alwaysOpen false', () => {
    const rows = model(false).declaredHours
    expect(rows.length).toBe(5)
    rows.forEach((row) => {
      expect(field(row, 'alwaysOpen')).toBe(false)
    })
  })
})

describe('G18: a missing zip is not a different address', () => {
  it('G18: a zip-less log row and an event LOCATION with a zip at the same street number mirror', () => {
    const canonical = model()
    const row = jobOf(canonical, 'row:4')
    expect(row).toBeDefined()
    expect(blockOf(canonical, 'job-quince-1')?.mirroredJobId).toBe(row?.id)
  })

  it('G18: an event at a genuinely different known address does not mirror', () => {
    expect(blockOf(model(), 'job-sample-2')?.mirroredJobId).toBeNull()
  })
})

describe('R8 (c): account_record tier', () => {
  it('R8(c): ACCOUNT_RECORD_CONFIDENCE is exported and is 1', () => {
    expect(field(canonicalModule, 'ACCOUNT_RECORD_CONFIDENCE')).toBe(1)
  })

  it("R8(c): each account_record link is the account's confidence times the tier's, with both as evidence", () => {
    const canonical = model()
    const links = canonical.providerLinks.filter((link) => link.method === ACCOUNT_RECORD_METHOD)
    expect(links.map((link) => link.record).sort()).toEqual(
      expect.arrayContaining([expect.stringContaining('job-wf-01')]),
    )
    const crmLink = links.find((link) => link.record.includes('job-wf-01'))
    expect(crmLink?.confidence).toBe(PROVIDER_CONFIDENCE.phone)
    expect(crmLink?.evidence).toEqual({
      providerKey: `jobber:${CRM}`,
      accountMethod: 'phone',
      accountConfidence: PROVIDER_CONFIDENCE.phone,
    })
    links.forEach((link) => {
      const accountConfidence = field(link.evidence, 'accountConfidence')
      expect(typeof accountConfidence).toBe('number')
      expect(link.confidence).toBe(Number(accountConfidence) * 1)
    })
  })
})
