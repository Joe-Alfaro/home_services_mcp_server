/*
 * G20: a "24/7 emergency service" profile must not yield round-the-clock high-confidence
 * openings. The engine treats it like "no reliable declared hours" (R13 e): openings come from
 * observed/inferred hours, at low confidence, with a reason naming the 24/7 claim.
 *
 * Expected API (src/availability/engine.ts):
 *
 *   export interface AvailabilityInput {
 *     …
 *     // From DeclaredHoursCandidate.alwaysOpen. When true, declaredHours are ignored and the
 *     // engine infers hours from history. Default false.
 *     declaredAlwaysOpen?: boolean
 *   }
 */
import { describe, expect, it } from 'vitest'
import { computeAvailability } from '../../../src/availability/engine.ts'
import { historyItem, makeInput, spans } from './support.ts'

/** What the profiles adapter parses "24/7 emergency service" to: every day 00:00-24:00. */
const ROUND_THE_CLOCK = ([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({
  weekday,
  start: '00:00',
  end: '24:00',
}))

// Observed Monday work in the last 90 days: 09:00-11:00, 13:00-15:00, 10:00-12:00 CDT.
const MONDAY_HISTORY = [
  historyItem('h-1', '2026-10-12T14:00:00Z', '2026-10-12T16:00:00Z'),
  historyItem('h-2', '2026-10-19T18:00:00Z', '2026-10-19T20:00:00Z'),
  historyItem('h-3', '2026-10-26T15:00:00Z', '2026-10-26T17:00:00Z'),
]

function alwaysOpenInput(history = MONDAY_HISTORY) {
  // A variable, not a literal, so the new field type-checks before the engine declares it.
  const input = {
    ...makeInput({ declaredHours: ROUND_THE_CLOCK, crewSize: null, history }),
    declaredAlwaysOpen: true,
  }
  return input
}

describe('G20: a 24/7 declared provider gets inferred hours at low confidence', () => {
  it('G20: openings come from observed Monday hours, not round the clock', () => {
    const result = computeAvailability(alwaysOpenInput())

    expect(result.hoursSource).toBe('inferred')
    // Inferred Monday 09:00-15:00 local on a CST Monday; nothing on Tue/Wed (no observed work).
    expect(spans(result.openings)).toEqual(['2026-11-02T15:00:00Z/2026-11-02T21:00:00Z'])
  })

  it('G20: every opening is low confidence with a reason naming the 24/7 claim', () => {
    const { openings } = computeAvailability(alwaysOpenInput())

    expect(openings.length).toBeGreaterThan(0)
    openings.forEach((o) => {
      expect(o.confidence).toBe('low')
      expect(o.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/24\/7|always/i)]))
    })
  })

  it('G20: a 24/7 provider with no observed work claims no openings', () => {
    const result = computeAvailability(alwaysOpenInput([]))

    expect(result.hoursSource).toBe('none')
    expect(result.openings).toEqual([])
  })

  it('G20: without the flag the same hours stay declared (the flag is what changes it)', () => {
    const result = computeAvailability(
      makeInput({ declaredHours: ROUND_THE_CLOCK, crewSize: null, history: MONDAY_HISTORY }),
    )

    expect(result.hoursSource).toBe('declared')
  })
})
