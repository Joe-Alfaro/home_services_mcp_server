/*
 * G9: rescheduling shows up only as a free-text note ("Rescheduled from M/D …") with no year.
 *
 * Expected API:
 *
 *   // src/adapters/shared.ts
 *   // "Rescheduled from M/D" → the local date it moved from. The year is the latest one that puts
 *   // that date on or before `jobDate` (12/30 on a 2026-01-02 job → 2025-12-30). null when the
 *   // note is not reschedule evidence, has no M/D, or the job has no date.
 *   export function rescheduledFromOf(note: string | null, jobDate: LocalDate | null): LocalDate | null
 *   // Unchanged name; "need to reschedule" style notes are a to-do, not evidence, so → null.
 *   export function rescheduleNoteOf(note: string | null): string | null
 *
 *   // src/adapters/types.ts
 *   export interface JobCandidate {
 *     …
 *     // Parsed from rescheduleNote with the job's local date. Optional in the type so hand-built
 *     // candidates in other tests still compile; every adapter sets it (null when none).
 *     rescheduledFrom?: LocalDate | null
 *   }
 */
import { describe, expect, it } from 'vitest'
import { housecallProAdapter } from '../../../src/adapters/housecallPro.ts'
import { jobberAdapter } from '../../../src/adapters/jobber.ts'
import * as shared from '../../../src/adapters/shared.ts'
import { spreadsheetAdapter } from '../../../src/adapters/spreadsheet.ts'
import type { CandidateBatch, JobCandidate } from '../../../src/adapters/types.ts'
import { workizAdapter } from '../../../src/adapters/workiz.ts'
import { exportedFunction, field } from '../pending.ts'
import { editText, loadFixtureFiles, makeCtx, one } from './support.ts'

type RescheduledFromOf = (note: string | null, jobDate: string | null) => string | null

function rescheduledFromOf(note: string | null, jobDate: string | null): string | null {
  return (exportedFunction(shared, 'rescheduledFromOf') as RescheduledFromOf)(note, jobDate)
}

function jobById(batch: CandidateBatch, id: string): JobCandidate {
  return one(batch.jobs, (job) => job.ref.sourceRecordId === id)
}

const CSV_FILE = 'sources/spreadsheet/tonys_handy_help_job_log.csv'

describe('G9: rescheduledFromOf', () => {
  it.each([
    ['Rescheduled from 11/3 per customer', '2026-11-05', '2026-11-03'],
    ['rescheduled from 11/03', '2026-11-05', '2026-11-03'],
    // Same day is "on or before".
    ['Rescheduled from 11/5', '2026-11-05', '2026-11-05'],
    // The year rule: the latest year that puts the date on or before the job date.
    ['Rescheduled from 12/30 per customer', '2026-01-02', '2025-12-30'],
    ['Rescheduled from 11/30', '2026-12-02', '2026-11-30'],
    ['Rescheduled from 11/6', '2026-11-05', '2025-11-06'],
  ])('G9: %j on a %s job → %s', (note, jobDate, expected) => {
    expect(rescheduledFromOf(note, jobDate)).toBe(expected)
  })

  it.each([
    ['need to reschedule', '2026-11-05'],
    ['Needs to reschedule 11/3, call back', '2026-11-05'],
    ['Rescheduled per customer', '2026-11-05'], // no M/D
    ['Rescheduled from 13/40', '2026-11-05'], // not a date
    [null, '2026-11-05'],
  ])('G9: %j is not reschedule evidence with a date → null', (note, jobDate) => {
    expect(rescheduledFromOf(note, jobDate)).toBeNull()
  })

  it('G9: a job without a date gets no rescheduledFrom', () => {
    expect(rescheduledFromOf('Rescheduled from 11/3', null)).toBeNull()
  })
})

describe('G9: rescheduleNoteOf keeps only "rescheduled" evidence', () => {
  it('G9: "Rescheduled from …" is kept', () => {
    expect(shared.rescheduleNoteOf('Rescheduled from 11/3 per customer')).toBe(
      'Rescheduled from 11/3 per customer',
    )
  })

  it.each(['need to reschedule', 'Needs to reschedule - call back', 'pls reschedule'])(
    'G9: %j is a to-do, not evidence → null',
    (note) => {
      expect(shared.rescheduleNoteOf(note)).toBeNull()
    },
  )
})

describe('G9: adapters expose rescheduledFrom', () => {
  it('G9: Workiz job on 2026-11-02 "Rescheduled from 10/30" → 2026-10-30', () => {
    const batch = workizAdapter.parse(loadFixtureFiles('workiz'), makeCtx())

    expect(field(jobById(batch, 'M3D8LV'), 'rescheduledFrom')).toBe('2026-10-30')
    expect(field(jobById(batch, 'K7P2QX'), 'rescheduledFrom')).toBeNull()
  })

  it('G9: Jobber visit on 2026-11-03 "Rescheduled from 10/29" → 2026-10-29', () => {
    const batch = jobberAdapter.parse(loadFixtureFiles('jobber'), makeCtx())

    expect(field(jobById(batch, 'Z2lkOi8vSm9iYmVyL1Zpc2l0LzkwMDA0MDQ'), 'rescheduledFrom')).toBe(
      '2026-10-29',
    )
  })

  it('G9: Housecall Pro job on 2026-12-02 "Rescheduled from 11/30" → 2026-11-30', () => {
    const batch = housecallProAdapter.parse(loadFixtureFiles('housecall_pro'), makeCtx())

    expect(field(jobById(batch, 'job_00000000000000000000000000000d03'), 'rescheduledFrom')).toBe(
      '2026-11-30',
    )
  })

  it('G9: CSV row "Fri 11/6" "Rescheduled from 11/4" → 2026-11-04, still one job', () => {
    const batch = spreadsheetAdapter.parse(loadFixtureFiles('spreadsheet'), makeCtx())
    const moved = jobById(batch, 'row:15')

    expect(field(moved, 'rescheduledFrom')).toBe('2026-11-04')
    expect(batch.jobs.filter((job) => job.notesRaw?.includes('Rescheduled') === true)).toHaveLength(
      1,
    )
  })

  it('G9: a CSV "need to reschedule" note is not evidence', () => {
    const files = editText(loadFixtureFiles('spreadsheet'), CSV_FILE, (content) =>
      content.replace('Rescheduled from 11/4 per customer', 'need to reschedule'),
    )
    const job = jobById(spreadsheetAdapter.parse(files, makeCtx()), 'row:15')

    expect(job.rescheduleNote).toBeNull()
    expect(field(job, 'rescheduledFrom')).toBeNull()
  })
})
