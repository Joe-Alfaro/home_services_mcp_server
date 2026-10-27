import { DateTime } from 'luxon'
import type { Instant, LocalDate } from '../adapters/types.ts'
import { TIME_ZONE } from '../config.ts'

// "YYYY-MM-DDTHH:MM[:SS]" or "YYYY-MM-DD HH:MM[:SS]" (Workiz uses a space).
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/

interface WallTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function parseWallTime(local: string): WallTime | null {
  const match = LOCAL_DATE_TIME.exec(local.trim())
  if (!match) return null
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part || 0))
  return {
    year: year ?? 0,
    month: month ?? 0,
    day: day ?? 0,
    hour: hour ?? 0,
    minute: minute ?? 0,
    second: second ?? 0,
  }
}

function sameWallTime(dt: DateTime, wall: WallTime): boolean {
  return (
    dt.year === wall.year &&
    dt.month === wall.month &&
    dt.day === wall.day &&
    dt.hour === wall.hour &&
    dt.minute === wall.minute &&
    dt.second === wall.second
  )
}

/** Formats a luxon DateTime as a UTC instant with a trailing "Z" and no milliseconds. */
export function toInstant(dt: DateTime): Instant | null {
  if (!dt.isValid) return null
  return dt.toUTC().toISO({ suppressMilliseconds: true })
}

/**
 * Reads a zone-less wall-clock time in `zone` (default America/Chicago) as an instant.
 * The repeated hour on a fall-back night resolves to the earlier (daylight) instant and a
 * nonexistent spring-forward time moves forward (D-031). Returns null when unparseable.
 */
export function localToInstant(local: string, zone: string = TIME_ZONE): Instant | null {
  const wall = parseWallTime(local)
  if (!wall) return null
  const dt = DateTime.fromObject(wall, { zone })
  // fromObject rolls invalid fields over in some cases; reject anything that did not round-trip
  // apart from the spring-forward gap, which legitimately moves the hour.
  if (!dt.isValid || dt.year !== wall.year || dt.month !== wall.month || dt.day !== wall.day) {
    return null
  }
  return toInstant(dt)
}

/** True when the wall-clock time occurs twice in `zone` (the fall-back hour). */
export function isAmbiguousLocal(local: string, zone: string = TIME_ZONE): boolean {
  const wall = parseWallTime(local)
  if (!wall) return false
  const dt = DateTime.fromObject(wall, { zone })
  if (!dt.isValid) return false
  return [-1, 1].some((hours) => sameWallTime(dt.plus({ hours }).setZone(zone), wall))
}

/** Reads an ISO timestamp with "Z" or an explicit offset as an instant; null when absent or bad. */
export function isoToInstant(raw: string | null | undefined): Instant | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null
  const trimmed = raw.trim()
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) return null
  return toInstant(DateTime.fromISO(trimmed, { setZone: true }))
}

/** The instants bounding a whole local day: [local midnight, next local midnight). */
export function localDayRange(
  date: LocalDate,
  zone: string = TIME_ZONE,
): { startAt: Instant; endAt: Instant } {
  const start = DateTime.fromISO(date, { zone }).startOf('day')
  const startAt = toInstant(start)
  const endAt = toInstant(start.plus({ days: 1 }))
  if (startAt === null || endAt === null) throw new Error(`Invalid local date: ${date}`)
  return { startAt, endAt }
}

/** Presents an instant in `zone` with its offset, e.g. "2026-11-02T09:00:00-06:00". */
export function formatLocal(instant: Instant, zone: string = TIME_ZONE): string {
  const formatted = DateTime.fromISO(instant, { setZone: true })
    .setZone(zone)
    .toISO({ suppressMilliseconds: true })
  if (formatted === null) throw new Error(`Invalid instant: ${instant}`)
  return formatted
}

/** The local calendar date of an instant in `zone`. */
export function localDateOf(instant: Instant, zone: string = TIME_ZONE): LocalDate {
  const date = DateTime.fromISO(instant, { setZone: true }).setZone(zone).toISODate()
  if (date === null) throw new Error(`Invalid instant: ${instant}`)
  return date
}
