import { DateTime } from 'luxon'
import { TIME_ZONE } from '../config.ts'

// Wall-time helpers for the availability engine. Everything goes through luxon with an explicit
// zone so results never depend on the host time zone (R12).

const MINUTES_PER_DAY = 24 * 60

/** The instant `ms` as America/Chicago wall time. */
export function localDateTime(ms: number): DateTime {
  return DateTime.fromMillis(ms, { zone: TIME_ZONE })
}

/** "YYYY-MM-DD" of a wall-time value. */
export function localDateKey(local: DateTime): string {
  return local.toFormat('yyyy-MM-dd')
}

export function minuteOfDay(local: DateTime): number {
  return local.hour * 60 + local.minute
}

/** "HH:mm" for a minute of the day; 1440 is "24:00" (end of day). */
export function formatMinuteOfDay(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

export function parseMinuteOfDay(hhmm: string): number {
  const [hours = '0', minutes = '0'] = hhmm.split(':')
  return Number(hours) * 60 + Number(minutes)
}

/**
 * The instant of wall time `minutes` on the local date of `day`. Built from calendar fields (not by
 * adding elapsed minutes to midnight) so DST days are right; 24:00 is the next local midnight.
 */
export function localTimeOnDay(day: DateTime, minutes: number): number {
  if (minutes >= MINUTES_PER_DAY) return day.startOf('day').plus({ days: 1 }).toMillis()
  return day
    .set({ hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0, millisecond: 0 })
    .toMillis()
}

/** Local dates (as start-of-day values) from the day of `fromMs` to the day of `toMs`, inclusive. */
export function localDaysBetween(fromMs: number, toMs: number): DateTime[] {
  const first = localDateTime(fromMs).startOf('day')
  const last = localDateTime(toMs).startOf('day')
  const count = Math.max(0, Math.round(last.diff(first, 'days').days)) + 1
  return Array.from({ length: count }, (_, index) => first.plus({ days: index }))
}

/** UTC ISO instant with a trailing Z and no milliseconds when they are zero. */
export function toInstant(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z')
}
