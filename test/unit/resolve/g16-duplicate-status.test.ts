/*
 * G16: two identical CSV rows are one job (duplicate_count 2), but a copy that differs in status
 * or notes is not a duplicate. A cancelled copy must not collapse into the scheduled row and
 * disappear; both rows stay separate jobs with their own status.
 *
 * Expected rule (src/resolve/jobs.ts, collapseDuplicateRows): the duplicate signature also
 * includes the status and the notes (normalized like the job text: case, punctuation and spacing
 * ignored).
 */
import { describe, expect, it } from 'vitest'
import { resolveJobs, type JobInput } from '../../../src/resolve/jobs.ts'
import { job } from './support.ts'

const PROVIDERS = new Map([['spreadsheet:dots_fixit_job_log', 'prov-dot']])
const PROPERTIES = new Map([['spreadsheet:dots_fixit_job_log:addr-1', 'home-liveoak']])

function resolve(jobs: readonly JobInput[]) {
  return resolveJobs({
    jobs,
    calendarBlocks: [],
    providerIdByKey: PROVIDERS,
    propertyIdByKey: PROPERTIES,
  })
}

function csvRow(row: number, fields: Parameters<typeof job>[3] = {}) {
  return job('spreadsheet', 'dots_fixit_job_log', `row:${String(row)}`, {
    propertyKey: 'spreadsheet:dots_fixit_job_log:addr-1',
    startAt: '2026-11-03T19:00:00Z', // 13:00 local
    timeBasis: 'local_assumed',
    tradeRaw: 'fence boards',
    amountCents: 16000,
    ...fields,
  })
}

const scheduled = csvRow(13)
const cancelledCopy = csvRow(14, { status: 'cancelled', statusRaw: 'cxl', notesRaw: 'cxl' })

describe('G16: duplicate CSV rows must agree on status and notes', () => {
  it('G16: a cancelled copy of a scheduled row is not collapsed into it', () => {
    const { jobs } = resolve([scheduled, cancelledCopy])

    expect(jobs).toHaveLength(2)
    expect(jobs.map((j) => j.status).sort()).toEqual(['cancelled', 'scheduled'])
    jobs.forEach((j) => {
      expect(j.duplicateCount).toBe(1)
      expect(j.links.map((l) => l.method)).not.toContain('duplicate_row')
    })
  })

  it('G16: the cancelled copy keeps its own record (the cancellation is not lost)', () => {
    const { jobs } = resolve([scheduled, cancelledCopy])
    const cancelled = jobs.find((j) => j.status === 'cancelled')

    expect(cancelled?.links.map((l) => l.ref.sourceRecordId)).toEqual(['row:14'])
  })

  it('G16: the result does not depend on which copy comes first', () => {
    const { jobs } = resolve([cancelledCopy, scheduled])

    expect(jobs.map((j) => j.status).sort()).toEqual(['cancelled', 'scheduled'])
  })

  it('G16: rows that differ only in notes are not duplicates', () => {
    const { jobs } = resolve([csvRow(13), csvRow(14, { notesRaw: 'waiting on parts' })])

    expect(jobs).toHaveLength(2)
  })

  it('G16: rows with the same status and notes (ignoring case and spacing) still collapse', () => {
    const { jobs } = resolve([
      csvRow(13, { notesRaw: 'Gate code 1234' }),
      csvRow(14, { notesRaw: '  gate code  1234 ' }),
    ])

    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.duplicateCount).toBe(2)
  })
})
