import { describe, expect, it } from 'vitest'
import { icsAdapter } from '../../../src/adapters/ics.ts'
import type { CalendarBlockCandidate } from '../../../src/adapters/types.ts'
import {
  editText,
  expectAllInstantsUtc,
  expectInstant,
  expectProvenance,
  expectUniqueRecordIds,
  loadFixtureFiles,
  makeCtx,
  one,
  toMs,
} from './support.ts'

const FILE = 'sources/calendars/marisol_handyman_google_calendar.ics'
const PROVIDER_KEY = 'ics:marisol_handyman_google_calendar'

function parseFixture(files = loadFixtureFiles('calendars'), ctx = makeCtx()) {
  return icsAdapter.parse(files, ctx)
}

function blocksOf(blocks: readonly CalendarBlockCandidate[], uid: string) {
  return blocks
    .filter((block) => block.ref.sourceRecordId.startsWith(`${uid}@`))
    .sort((a, b) => toMs(a.startAt) - toMs(b.startAt))
}

function blockOf(blocks: readonly CalendarBlockCandidate[], uid: string) {
  return one(blocks, (block) => block.ref.sourceRecordId.startsWith(`${uid}@`))
}

describe('icsAdapter', () => {
  it('declares its source system and data pack pattern', () => {
    expect(icsAdapter.sourceSystem).toBe('ics')
    expect(icsAdapter.patterns.length).toBeGreaterThan(0)
    icsAdapter.patterns.forEach((pattern) => {
      expect(pattern.startsWith('sources/calendars/')).toBe(true)
    })
  })

  it('is pure: the same input gives the same output', () => {
    expect(parseFixture()).toEqual(parseFixture())
  })

  describe('provenance (R11)', () => {
    it('stamps every candidate with system, file stem, file, record ID and run time', () => {
      const batch = parseFixture()
      expectProvenance(batch, { sourceSystem: 'ics', sourceFiles: [FILE] })
      expectUniqueRecordIds(batch)
      batch.calendarBlocks.forEach((block) => {
        expect(block.ref.sourceAccount).toBe('marisol_handyman_google_calendar')
      })
    })

    it('identifies each occurrence as "<UID>@<occurrence start>"', () => {
      const blocks = parseFixture().calendarBlocks
      blocks.forEach((block) => {
        expect(block.ref.sourceRecordId).toMatch(/@google\.com@/)
        expect(block.ref.sourceRecordId.endsWith(`@${block.startAt}`)).toBe(true)
      })
      const single = blockOf(blocks, 'tzid-job-1')
      expect(single.ref.sourceRecordId).toBe(`tzid-job-1@google.com@${single.startAt}`)
    })
  })

  describe('provider', () => {
    it('emits one provider per calendar, named from X-WR-CALNAME', () => {
      const provider = one(parseFixture().providers, () => true)
      expect(provider.providerKey).toBe(PROVIDER_KEY)
      expect(provider.businessName).toBe('Marisol Quintero (work)')
      expect(provider.ref.sourceFile).toBe(FILE)
    })
  })

  describe('blocks', () => {
    it('emits one block per occurrence inside the window and nothing else', () => {
      const batch = parseFixture()
      // 11 single events in the window, 4 occurrences of the weekly Friday event (one
      // EXDATE), 5 of the open-ended Monday event; the 2023 event is outside the window.
      expect(batch.calendarBlocks).toHaveLength(20)
      expect(batch.properties).toEqual([])
      expect(batch.jobs).toEqual([])
      expect(batch.declaredHours).toEqual([])
      batch.calendarBlocks.forEach((block) => {
        expect(block.providerKey).toBe(PROVIDER_KEY)
      })
      expectAllInstantsUtc(batch)
    })

    it('ignores the VTIMEZONE rules and events outside the history window', () => {
      const batch = parseFixture()
      expect(blocksOf(batch.calendarBlocks, 'ancient-13')).toEqual([])
      batch.calendarBlocks.forEach((block) => {
        expect(toMs(block.startAt)).toBeGreaterThan(Date.parse('2024-01-01T00:00:00Z'))
      })
    })

    it('reads a TZID=America/Chicago event as an explicit zone', () => {
      const block = blockOf(parseFixture().calendarBlocks, 'tzid-job-1')
      expectInstant(block.startAt, '2026-11-03T15:00:00Z')
      expectInstant(block.endAt, '2026-11-03T16:30:00Z')
      expect(block.timeBasis).toBe('explicit_zone')
      expect(block.allDay).toBe(false)
      expect(block.busy).toBe(true)
      expect(block.recurrence).toBeNull()
      expect(block.summaryRaw).toBe('Job - Fairbanks (4526 live oak st)')
    })

    it('keeps a UTC event as the same instant', () => {
      const block = blockOf(parseFixture().calendarBlocks, 'utc-job-2')
      expectInstant(block.startAt, '2026-10-30T16:00:00Z')
      expectInstant(block.endAt, '2026-10-30T17:30:00Z')
    })

    it('reads a floating event as Chicago local time', () => {
      const block = blockOf(parseFixture().calendarBlocks, 'floating-est-3')
      expectInstant(block.startAt, '2026-10-31T14:00:00Z')
      expectInstant(block.endAt, '2026-10-31T16:00:00Z')
      expect(block.timeBasis).toBe('local_assumed')
    })

    it('makes an all-day event cover the whole local day (R4 h, R12 d)', () => {
      const block = blockOf(parseFixture().calendarBlocks, 'allday-ooo-4')
      expectInstant(block.startAt, '2026-11-03T06:00:00Z')
      expectInstant(block.endAt, '2026-11-04T06:00:00Z')
      expect(block.allDay).toBe(true)
      expect(block.timeBasis).toBe('date_only')
      expect(block.busy).toBe(true)
    })

    it('treats a multi-day all-day end date as exclusive (G17)', () => {
      const block = blockOf(parseFixture().calendarBlocks, 'allday-multi-14')
      // 20261110 -> 20261113 blocks Nov 10-12 local, not Nov 13.
      expectInstant(block.startAt, '2026-11-10T06:00:00Z')
      expectInstant(block.endAt, '2026-11-13T06:00:00Z')
      expect(block.allDay).toBe(true)
    })

    it('makes an all-day event on the DST change day 25 hours long', () => {
      const block = blockOf(parseFixture().calendarBlocks, 'allday-dst-5')
      expectInstant(block.startAt, '2026-11-01T05:00:00Z')
      expectInstant(block.endAt, '2026-11-02T06:00:00Z')
    })

    it('expands a weekly RRULE, honours EXDATE and keeps local wall time across DST (R4 h)', () => {
      const occurrences = blocksOf(parseFixture().calendarBlocks, 'weekly-pickup-6')
      expect(occurrences.map((block) => new Date(toMs(block.startAt)).toISOString())).toEqual([
        '2026-10-23T14:00:00.000Z',
        '2026-10-30T14:00:00.000Z',
        // 2026-11-06 is excluded by EXDATE
        '2026-11-13T15:00:00.000Z',
        '2026-11-20T15:00:00.000Z',
      ])
      occurrences.forEach((block) => {
        expect(toMs(block.endAt) - toMs(block.startAt)).toBe(2 * 60 * 60 * 1000)
        expect(block.recurrence).toEqual({
          masterUid: 'weekly-pickup-6@google.com',
          rrule: 'FREQ=WEEKLY;BYDAY=FR;UNTIL=20261121T000000Z',
        })
        expect(block.busy).toBe(true)
      })
    })

    it('stops an open-ended RRULE at today + horizonDays', () => {
      const occurrences = blocksOf(parseFixture().calendarBlocks, 'weekly-lunch-12')
      expect(occurrences.map((block) => new Date(toMs(block.startAt)).toISOString())).toEqual([
        '2026-11-02T18:00:00.000Z',
        '2026-11-09T18:00:00.000Z',
        '2026-11-16T18:00:00.000Z',
        '2026-11-23T18:00:00.000Z',
        '2026-11-30T18:00:00.000Z',
      ])
    })

    it('uses the context window, not a built-in one', () => {
      const batch = parseFixture(undefined, makeCtx({ horizonDays: 8 }))
      expect(blocksOf(batch.calendarBlocks, 'weekly-lunch-12')).toHaveLength(2)
    })
  })

  describe('busy and category (R4 h)', () => {
    it('tags personal events as personal and keeps them busy', () => {
      const blocks = parseFixture().calendarBlocks
      ;['dentist-7', 'allday-ooo-4', 'weekly-lunch-12', 'weekly-pickup-6'].forEach((uid) => {
        blocksOf(blocks, uid).forEach((block) => {
          expect(block.category).toBe('personal')
          expect(block.busy).toBe(true)
        })
      })
    })

    it('tags customer jobs and estimates as work', () => {
      const blocks = parseFixture().calendarBlocks
      expect(blockOf(blocks, 'tzid-job-1').category).toBe('work')
      expect(blockOf(blocks, 'floating-est-3').category).toBe('work')
    })

    it('marks TRANSP:TRANSPARENT as not busy', () => {
      expect(blockOf(parseFixture().calendarBlocks, 'admin-8').busy).toBe(false)
    })

    it('marks STATUS:CANCELLED as not busy', () => {
      expect(blockOf(parseFixture().calendarBlocks, 'cancelled-9').busy).toBe(false)
    })

    it('marks a "CXL" summary as a cancelled job that does not block time', () => {
      const block = blockOf(parseFixture().calendarBlocks, 'cxl-10')
      expect(block.busy).toBe(false)
      expect(block.category).toBe('work')
    })

    it('keeps a TENTATIVE hold busy (the cautious answer wins)', () => {
      expect(blockOf(parseFixture().calendarBlocks, 'hold-11').busy).toBe(true)
    })
  })

  it('handles CRLF line endings and folded lines', () => {
    const files = editText(loadFixtureFiles('calendars'), FILE, (content) =>
      content
        .replace(
          'SUMMARY:Job - Fairbanks (4526 live oak st)',
          'SUMMARY:Job - Fairbanks (4526 l\n ive oak st)',
        )
        .replace(/\n/g, '\r\n'),
    )
    const blocks = parseFixture(files).calendarBlocks
    expect(blocks).toHaveLength(20)
    expect(blockOf(blocks, 'tzid-job-1').summaryRaw).toBe('Job - Fairbanks (4526 live oak st)')
  })
})
