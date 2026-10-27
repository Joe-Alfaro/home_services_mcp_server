import { describe, expect, it } from 'vitest'
import { spreadsheetAdapter } from '../../../src/adapters/spreadsheet.ts'
import type { CandidateBatch, JobCandidate } from '../../../src/adapters/types.ts'
import {
  editText,
  expectAllInstantsUtc,
  expectInstant,
  expectIssuesFreeOf,
  expectProvenance,
  expectUniqueRecordIds,
  issuesFor,
  loadFixtureFiles,
  makeCtx,
  one,
} from './support.ts'

const FILE = 'sources/spreadsheet/tonys_handy_help_job_log.csv'
const PROVIDER_KEY = 'spreadsheet:tonys_handy_help_job_log'

// The fixture has two preamble lines and the header on line 3, so data starts at row:4.
// Rows are in chronological order; the sheet was exported Friday 2026-10-30.
const DATA_ROWS = Array.from({ length: 14 }, (_, index) => `row:${String(index + 4)}`)

function parseFixture(files = loadFixtureFiles('spreadsheet')) {
  return spreadsheetAdapter.parse(files, makeCtx())
}

function row(batch: CandidateBatch, line: number): JobCandidate {
  return one(batch.jobs, (job) => job.ref.sourceRecordId === `row:${String(line)}`)
}

describe('spreadsheetAdapter', () => {
  it('declares its source system and data pack pattern', () => {
    expect(spreadsheetAdapter.sourceSystem).toBe('spreadsheet')
    expect(spreadsheetAdapter.patterns.length).toBeGreaterThan(0)
    spreadsheetAdapter.patterns.forEach((pattern) => {
      expect(pattern.startsWith('sources/spreadsheet/')).toBe(true)
    })
  })

  it('is pure: the same input gives the same output', () => {
    expect(parseFixture()).toEqual(parseFixture())
  })

  describe('provenance (R11)', () => {
    it('stamps every candidate with system, file stem, file, record ID and run time', () => {
      const batch = parseFixture()
      expectProvenance(batch, { sourceSystem: 'spreadsheet', sourceFiles: [FILE] })
      expectUniqueRecordIds(batch)
      batch.jobs.forEach((job) => {
        expect(job.ref.sourceAccount).toBe('tonys_handy_help_job_log')
      })
    })

    it('uses "row:<physical line>" as the record ID of each data row', () => {
      expect(
        parseFixture()
          .jobs.map((job) => job.ref.sourceRecordId)
          .sort(),
      ).toEqual([...DATA_ROWS].sort())
    })

    it('derives property record IDs from the first row that names the address', () => {
      const batch = parseFixture()
      batch.properties.forEach((property) => {
        expect(property.ref.sourceRecordId).toMatch(/^row:\d+#address$/)
      })
      const first = one(batch.properties, (p) => p.propertyKey === row(batch, 4).propertyKey)
      expect(first.ref.sourceRecordId).toBe('row:4#address')
    })

    it('never puts homeowner PII in issue messages', () => {
      expectIssuesFreeOf(parseFixture(), ['Brenner', 'Quill', 'Odessa', '972-555-0148'])
    })
  })

  describe('provider', () => {
    it('emits one provider per file, named from the title row', () => {
      const provider = one(parseFixture().providers, () => true)
      expect(provider.providerKey).toBe(PROVIDER_KEY)
      expect(provider.businessName).toBe("Tony's Handy Help")
      expect(provider.ref.sourceFile).toBe(FILE)
    })
  })

  describe('rows (R4 g)', () => {
    it('skips the preamble rows and the header', () => {
      const batch = parseFixture()
      expect(batch.jobs).toHaveLength(14)
      batch.jobs.forEach((job) => {
        expect(job.tradeRaw).not.toBe('Job')
        expect(job.tradeRaw ?? '').not.toContain('JOB LOG')
      })
    })

    it('keeps the Job column as trade text', () => {
      const batch = parseFixture()
      expect(row(batch, 4).tradeRaw).toBe('tv mount')
      expect(row(batch, 12).tradeRaw).toBe('assemble IKEA')
    })

    it('turns blank cells into null', () => {
      const batch = parseFixture()
      const estimate = row(batch, 6) // blank Phone, $ and Paid?
      expect(estimate.amountCents).toBeNull()
      expect(estimate.amountRaw).toBeNull()
      const plain = row(batch, 4) // blank Notes
      expect(plain.notesRaw).toBeNull()
      expect(plain.rescheduleNote).toBeNull()
      const property = one(batch.properties, (p) => p.propertyKey === estimate.propertyKey)
      expect(property.contact?.phones).toEqual([])
    })

    it('reports a row with an unparseable date as an issue and keeps it unslotted', () => {
      const batch = parseFixture()
      const job = row(batch, 9) // Date "??"
      expect(job.startAt).toBeNull()
      expect(job.timeBasis).toBeNull()
      expect(job.tradeRaw).toBe('furniture build')
      const issues = issuesFor(batch, 'row:9')
      expect(issues.length).toBeGreaterThan(0)
      issues.forEach((issue) => {
        expect(['warn', 'error']).toContain(issue.severity)
      })
    })

    it('keeps a "2nd trip" row on its own date as a separate job (G16)', () => {
      const batch = parseFixture()
      expect(row(batch, 17).propertyKey).toBe(row(batch, 9).propertyKey)
      expect(row(batch, 17).ref.sourceRecordId).not.toBe(row(batch, 9).ref.sourceRecordId)
    })

    it('keeps duplicate rows as separate jobs and flags the repeat (resolve collapses them)', () => {
      const batch = parseFixture()
      const first = row(batch, 13)
      const second = row(batch, 14)
      expect(second.startAt).toBe(first.startAt)
      expect(second.tradeRaw).toBe(first.tradeRaw)
      expect(second.propertyKey).toBe(first.propertyKey)
      const flags = issuesFor(batch, 'row:14')
      expect(flags.length).toBeGreaterThan(0)
      flags.forEach((issue) => {
        expect(issue.severity).toBe('info')
        expect(issue.code.startsWith('csv.')).toBe(true)
      })
    })

    it('never invents an end time', () => {
      parseFixture().jobs.forEach((job) => {
        if (!job.allDay) expect(job.endAt).toBeNull()
      })
    })

    it('marks estimate rows as kind "estimate" and the rest as jobs', () => {
      const batch = parseFixture()
      expect(row(batch, 6).kind).toBe('estimate')
      batch.jobs
        .filter((job) => job.ref.sourceRecordId !== 'row:6')
        .forEach((job) => {
          expect(job.kind).toBe('job')
        })
    })
  })

  describe('loose dates and times (R4 g, R12)', () => {
    it.each([
      [4, '2024-11-12T15:30:00Z'], // "11/12/24" "9:30am", CST
      [5, '2024-11-20T19:15:00Z'], // "11/20" (year from neighbouring rows) "1:15" = 1:15 pm
      [6, '2024-12-02T20:00:00Z'], // "12/02/2024" "14:00"
      [8, '2026-10-22T20:00:00Z'], // "10/22/26" "3pm", CDT
      [10, '2026-10-28T13:15:00Z'], // "10/28" "8:15"
      [11, '2026-10-31T14:00:00Z'], // "10/31/2026" "9:00", CDT, day before DST ends
      [12, '2026-11-02T14:00:00Z'], // "Mon" = first Monday after export, CST
      [13, '2026-11-03T19:00:00Z'], // "next tues" "13:00"
      [15, '2026-11-06T14:00:00Z'], // "Fri 11/6" "8am"
      [17, '2026-11-05T15:00:00Z'], // "Thurs" "9am" (G16)
    ])('reads row %i as %s', (line, expected) => {
      const job = row(parseFixture(), line)
      expectInstant(job.startAt, expected)
      expect(job.timeBasis).toBe('local_assumed')
      expect(job.allDay).toBe(false)
    })

    it('treats a row with a date but no time as an all-day, date-only row', () => {
      const batch = parseFixture()
      const daylight = row(batch, 7) // "2025-03-20", blank time
      expect(daylight.timeBasis).toBe('date_only')
      expect(daylight.allDay).toBe(true)
      expectInstant(daylight.startAt, '2025-03-20T05:00:00Z')

      const standard = row(batch, 16) // "11/9", blank time
      expect(standard.timeBasis).toBe('date_only')
      expect(standard.allDay).toBe(true)
      expectInstant(standard.startAt, '2026-11-09T06:00:00Z')
      expectAllInstantsUtc(batch)
    })
  })

  describe('money (R4 e)', () => {
    it.each([
      [4, '$145', 14500],
      [5, '145', 14500],
      [7, '145.00', 14500],
      [8, '$99', 9900],
    ])('reads row %i amount %j as %i cents', (line, raw, cents) => {
      const job = row(parseFixture(), line)
      expect(job.amountRaw).toBe(raw)
      expect(job.amountCents).toBe(cents)
    })
  })

  describe('status from the Notes column (R9)', () => {
    it.each([
      [8, 'cancelled'], // "cust cancelled"
      [10, 'cancelled'], // "cxl"
      [16, 'on_hold'], // "waiting on parts"
      [4, 'completed'], // blank note, dated before the export
      [7, 'completed'],
      [12, 'scheduled'], // blank note, in the future
      [15, 'scheduled'], // rescheduled, in the future
    ])('maps row %i to %j', (line, status) => {
      expect(row(parseFixture(), line).status).toBe(status)
    })

    it('treats a row after the export date that is already past "now" as limbo', () => {
      // 2026-10-31 was still upcoming when the sheet was exported on 10/30; nobody recorded it.
      expect(row(parseFixture(), 11).status).toBe('limbo')
    })

    it('keeps "Rescheduled from …" as evidence', () => {
      expect(row(parseFixture(), 15).rescheduleNote).toContain('Rescheduled from 11/4')
    })

    it('recognises CANCELLED in any case', () => {
      const files = editText(loadFixtureFiles('spreadsheet'), FILE, (content) =>
        content.replace('cust cancelled', 'CANCELLED'),
      )
      expect(row(parseFixture(files), 8).status).toBe('cancelled')
    })
  })

  describe('properties', () => {
    it('emits one property per distinct free-text address', () => {
      const batch = parseFixture()
      expect(batch.properties).toHaveLength(7)
      expect(row(batch, 4).propertyKey).toBe(row(batch, 8).propertyKey)
      expect(row(batch, 5).propertyKey).toBe(row(batch, 6).propertyKey)
      expect(row(batch, 12).propertyKey).toBe(row(batch, 13).propertyKey)
      // Different spellings stay distinct here; the address normalizer merges them later.
      expect(row(batch, 4).propertyKey).not.toBe(row(batch, 7).propertyKey)
    })

    it('stores the address as free text only', () => {
      const batch = parseFixture()
      const property = one(batch.properties, (p) => p.propertyKey === row(batch, 4).propertyKey)
      expect(property.providerKey).toBe(PROVIDER_KEY)
      expect(property.address).toEqual({
        line1: null,
        line2: null,
        city: null,
        state: null,
        zip: null,
        freeText: '4520 live oak st., 75204',
      })
    })

    it('keeps the customer as contact PII', () => {
      const batch = parseFixture()
      const property = one(batch.properties, (p) => p.propertyKey === row(batch, 4).propertyKey)
      expect(property.contact?.name).toBe('Mrs. Quill')
      expect(property.contact?.phones).toEqual(['214.555.0191'])
      expect(property.contact?.emails).toEqual([])
    })
  })

  it('handles CRLF line endings the same way', () => {
    const files = editText(loadFixtureFiles('spreadsheet'), FILE, (content) =>
      content.replace(/\n/g, '\r\n'),
    )
    const batch = parseFixture(files)
    expect(batch.jobs.map((job) => job.ref.sourceRecordId).sort()).toEqual([...DATA_ROWS].sort())
  })

  it('produces no calendar blocks or declared hours', () => {
    const batch = parseFixture()
    expect(batch.calendarBlocks).toEqual([])
    expect(batch.declaredHours).toEqual([])
  })
})
