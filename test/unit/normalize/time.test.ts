import { describe, expect, it } from 'vitest'
import {
  formatLocal,
  isAmbiguousLocal,
  localDayRange,
  localToInstant,
} from '../../../src/normalize/time.ts'
import { expectInstant } from '../adapters/support.ts'

// R12: zone-less source times are America/Chicago wall time, DST-aware (DST ends 2026-11-01).
describe('localToInstant', () => {
  it.each([
    ['2026-10-31T09:00', '2026-10-31T14:00:00Z'], // CDT, UTC-5
    ['2026-10-31T09:00:00', '2026-10-31T14:00:00Z'],
    ['2026-11-02T09:00', '2026-11-02T15:00:00Z'], // CST, UTC-6
    ['2026-12-02T12:15:00', '2026-12-02T18:15:00Z'], // R4 (d)
    ['2026-11-04 09:00:00', '2026-11-04T15:00:00Z'], // Workiz "YYYY-MM-DD HH:MM:SS"
    ['2026-11-01T03:00:00', '2026-11-01T09:00:00Z'], // after the fall-back, CST
    ['2026-11-01T00:30:00', '2026-11-01T05:30:00Z'], // before the fall-back, CDT
  ])('reads %s as Chicago local time', (local, expected) => {
    expectInstant(localToInstant(local), expected)
  })

  it('resolves the repeated hour 2026-11-01T01:30 to the earlier (CDT) instant', () => {
    // Documented choice: the first occurrence, 01:30 CDT = 06:30Z (not 01:30 CST = 07:30Z).
    expectInstant(localToInstant('2026-11-01T01:30:00'), '2026-11-01T06:30:00Z')
  })

  it('accepts an explicit zone argument', () => {
    expectInstant(localToInstant('2026-11-02T09:00', 'America/Chicago'), '2026-11-02T15:00:00Z')
  })

  it.each(['', 'not a date', '2026-13-40T09:00'])('returns null for unparseable %j', (raw) => {
    expect(localToInstant(raw)).toBeNull()
  })
})

describe('isAmbiguousLocal', () => {
  it('flags wall-clock times that occur twice on the DST fall-back night', () => {
    expect(isAmbiguousLocal('2026-11-01T01:30:00')).toBe(true)
    expect(isAmbiguousLocal('2026-11-01T01:00:00')).toBe(true)
  })

  it('does not flag ordinary times', () => {
    expect(isAmbiguousLocal('2026-11-01T00:59:00')).toBe(false)
    expect(isAmbiguousLocal('2026-11-01T02:00:00')).toBe(false)
    expect(isAmbiguousLocal('2026-11-02T01:30:00')).toBe(false)
  })
})

describe('localDayRange', () => {
  it('covers a whole standard-time local day (R12 d)', () => {
    const range = localDayRange('2026-11-03')
    expectInstant(range.startAt, '2026-11-03T06:00:00Z')
    expectInstant(range.endAt, '2026-11-04T06:00:00Z')
  })

  it('covers a daylight-time local day', () => {
    const range = localDayRange('2026-10-31')
    expectInstant(range.startAt, '2026-10-31T05:00:00Z')
    expectInstant(range.endAt, '2026-11-01T05:00:00Z')
  })

  it('makes the fall-back day 25 hours long', () => {
    const range = localDayRange('2026-11-01')
    expectInstant(range.startAt, '2026-11-01T05:00:00Z')
    expectInstant(range.endAt, '2026-11-02T06:00:00Z')
  })
})

describe('formatLocal', () => {
  // R12 (e): presented times carry a Chicago offset, never bare UTC.
  it.each([
    ['2026-11-02T15:00:00Z', '2026-11-02T09:00:00-06:00'],
    ['2026-10-31T14:00:00Z', '2026-10-31T09:00:00-05:00'],
    ['2026-11-01T06:30:00Z', '2026-11-01T01:30:00-05:00'],
    ['2026-11-01T07:30:00Z', '2026-11-01T01:30:00-06:00'],
  ])('formats %s as %s', (instant, expected) => {
    expect(formatLocal(instant)).toBe(expected)
  })
})
