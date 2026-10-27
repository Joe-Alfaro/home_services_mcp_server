/*
 * Expected API of src/availability/inferredHours.ts (pure: no clock, no host time zone):
 *
 *   import type { HistoryItem, Instant, WeeklyHours } from './engine.ts'
 *
 *   // R13(e): weekly hours inferred from observed work. For each ISO weekday (in America/Chicago
 *   // wall time), the earliest local start and the latest local end of the items that start in
 *   // [now - lookbackDays, now). Items without an end are ignored. Sorted by weekday; weekdays
 *   // with no work are absent; [] when nothing qualifies.
 *   export function inferWeeklyHours(
 *     history: readonly HistoryItem[],
 *     options: { now: Instant; lookbackDays?: number }, // lookbackDays default 90
 *   ): WeeklyHours[]
 */
import { afterEach, describe, expect, it } from 'vitest'
import { inferWeeklyHours } from '../../../src/availability/inferredHours.ts'
import { NOW, historyItem } from './support.ts'

describe('inferWeeklyHours', () => {
  const originalTz = process.env.TZ
  afterEach(() => {
    if (originalTz === undefined) {
      delete process.env.TZ
      return
    }
    process.env.TZ = originalTz
  })

  it('R13(e): takes the earliest local start and latest local end per weekday', () => {
    const history = [
      historyItem('h-1', '2026-10-12T14:00:00Z', '2026-10-12T16:00:00Z'), // Mon 09:00-11:00 CDT
      historyItem('h-2', '2026-10-19T18:00:00Z', '2026-10-19T20:00:00Z'), // Mon 13:00-15:00 CDT
      historyItem('h-3', '2026-10-28T15:00:00Z', '2026-10-28T17:00:00Z'), // Wed 10:00-12:00 CDT
    ]

    expect(inferWeeklyHours(history, { now: NOW })).toEqual([
      { weekday: 1, start: '09:00', end: '15:00' },
      { weekday: 3, start: '10:00', end: '12:00' },
    ])
  })

  it('R12/R13(e): uses Chicago wall time on both sides of the DST change', () => {
    const history = [
      historyItem('h-cdt', '2026-10-26T14:00:00Z', '2026-10-26T16:00:00Z'), // Mon 09:00-11:00 CDT
      historyItem('h-cst', '2026-11-09T15:00:00Z', '2026-11-09T17:00:00Z'), // Mon 09:00-11:00 CST
    ]

    expect(inferWeeklyHours(history, { now: '2026-11-16T06:00:00Z' })).toEqual([
      { weekday: 1, start: '09:00', end: '11:00' },
    ])
  })

  it('R12: does not depend on the host time zone', () => {
    process.env.TZ = 'Asia/Tokyo'
    const history = [historyItem('h-1', '2026-10-26T14:00:00Z', '2026-10-26T16:00:00Z')]

    expect(inferWeeklyHours(history, { now: NOW })).toEqual([
      { weekday: 1, start: '09:00', end: '11:00' },
    ])
  })

  it('R13(e): looks back 90 days by default', () => {
    const history = [
      historyItem('h-91', '2026-08-03T14:00:00Z', '2026-08-03T16:00:00Z'), // Mon, 91 days back
      historyItem('h-89', '2026-08-05T14:00:00Z', '2026-08-05T16:00:00Z'), // Wed, 89 days back
    ]

    expect(inferWeeklyHours(history, { now: NOW })).toEqual([
      { weekday: 3, start: '09:00', end: '11:00' },
    ])
  })

  it('R13(e): lookbackDays is configurable', () => {
    const history = [
      historyItem('h-89', '2026-08-05T14:00:00Z', '2026-08-05T16:00:00Z'),
      historyItem('h-7', '2026-10-28T15:00:00Z', '2026-10-28T17:00:00Z'),
    ]

    expect(inferWeeklyHours(history, { now: NOW, lookbackDays: 30 })).toEqual([
      { weekday: 3, start: '10:00', end: '12:00' },
    ])
  })

  it('R14: ignores work at or after now and work without an end', () => {
    const history = [
      historyItem('h-future', '2026-11-03T15:00:00Z', '2026-11-03T17:00:00Z'), // Tue, after now
      historyItem('h-at-now', NOW, '2026-11-02T08:00:00Z'), // starts exactly at now
      historyItem('h-noend', '2026-10-29T15:00:00Z', null), // Thu, no end
    ]

    expect(inferWeeklyHours(history, { now: NOW })).toEqual([])
  })

  it('R13(e)/G20: no observed work → no inferred hours', () => {
    expect(inferWeeklyHours([], { now: NOW })).toEqual([])
  })
})
