/*
 * G17: `STATUS:TENTATIVE` blocks with a reason. The adapter must keep the event status so a
 * tentative hold reaches the availability engine as BusyItem status 'tentative' (a low-confidence
 * block with a reason) instead of a plain confirmed busy block.
 *
 * Expected API (src/adapters/types.ts):
 *
 *   export interface CalendarBlockCandidate {
 *     …
 *     // ICS STATUS, lower-cased; an event without STATUS is 'confirmed'. The values are the
 *     // matching BusyStatus values in src/availability/engine.ts.
 *     status: 'confirmed' | 'tentative' | 'cancelled'
 *   }
 */
import { describe, expect, it } from 'vitest'
import { icsAdapter } from '../../../src/adapters/ics.ts'
import type { CalendarBlockCandidate } from '../../../src/adapters/types.ts'
import type { BusyItem, BusyStatus } from '../../../src/availability/engine.ts'
import { computeAvailability } from '../../../src/availability/engine.ts'
import { makeInput } from '../availability/support.ts'
import { field } from '../pending.ts'
import { editText, loadFixtureFiles, makeCtx, one } from './support.ts'

const FILE = 'sources/calendars/marisol_handyman_google_calendar.ics'

function parse(files = loadFixtureFiles('calendars')) {
  return icsAdapter.parse(files, makeCtx())
}

function blockOf(blocks: readonly CalendarBlockCandidate[], uid: string) {
  return one(blocks, (block) => block.ref.sourceRecordId.startsWith(`${uid}@`))
}

/** The adapter-to-engine hand-off this gap is about: the block's own status, not a default. */
function toBusyItem(block: CalendarBlockCandidate): BusyItem {
  return {
    kind: 'calendar_block',
    status: field(block, 'status') as BusyStatus,
    startAt: block.startAt,
    endAt: block.endAt,
    allDay: block.allDay,
    busy: block.busy,
    confidence: 'high',
    sources: [
      {
        sourceSystem: block.ref.sourceSystem,
        sourceFile: block.ref.sourceFile,
        sourceRecordId: block.ref.sourceRecordId,
      },
    ],
    category: block.category,
  }
}

describe('G17: ICS event status reaches the engine', () => {
  it('G17: STATUS:TENTATIVE → status "tentative", still busy', () => {
    const hold = blockOf(parse().calendarBlocks, 'hold-11')

    expect(field(hold, 'status')).toBe('tentative')
    expect(hold.busy).toBe(true)
  })

  it('G17: STATUS:CONFIRMED → "confirmed", STATUS:CANCELLED → "cancelled"', () => {
    const blocks = parse().calendarBlocks

    expect(field(blockOf(blocks, 'tzid-job-1'), 'status')).toBe('confirmed')
    expect(field(blockOf(blocks, 'cancelled-9'), 'status')).toBe('cancelled')
  })

  it('G17: an event without STATUS is "confirmed"', () => {
    const files = editText(loadFixtureFiles('calendars'), FILE, (content) =>
      content.replace(/(UID:tzid-job-1@google\.com\r?\n(?:.*\r?\n)*?)STATUS:CONFIRMED\r?\n/, '$1'),
    )
    const block = blockOf(parse(files).calendarBlocks, 'tzid-job-1')

    expect(field(block, 'status')).toBe('confirmed')
  })

  it('G17: the tentative hold blocks at low confidence with a tentative reason', () => {
    const hold = blockOf(parse().calendarBlocks, 'hold-11')
    // Fri 2026-11-06 13:00-15:00 CST; open Mon-Sun 08-17 over that day.
    const result = computeAvailability(
      makeInput({
        declaredHours: ([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({
          weekday,
          start: '08:00',
          end: '17:00',
        })),
        busy: [toBusyItem(hold)],
        window: { from: '2026-11-06T06:00:00Z', to: '2026-11-07T06:00:00Z' },
      }),
    )

    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0]?.confidence).toBe('low')
    expect(result.blocks[0]?.reasons).toEqual(
      expect.arrayContaining([expect.stringMatching(/tentative/i)]),
    )
  })
})
