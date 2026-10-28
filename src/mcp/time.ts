import { DateTime } from 'luxon'
import { TIME_ZONE } from '../config.ts'

/** Told to the agent in every relative-window tool description (R14, D-149). */
export const SERVER_TODAY_NOTE =
  "Windows are relative to the server's today (query.today in every response), not the caller's clock or date."

/** Relative windows an agent may name (local dates, start inclusive, end exclusive). */
export const WINDOWS = [
  'today',
  'tomorrow',
  'next_3_days',
  'next_7_days',
  'this_week',
  'next_week',
  'next_14_days',
] as const

export type WindowName = (typeof WINDOWS)[number]

/** Local calendar dates in America/Chicago; `to` is exclusive. */
export interface LocalWindow {
  from: string
  to: string
}

function localDay(date: string): DateTime {
  return DateTime.fromISO(date, { zone: TIME_ZONE }).startOf('day')
}

function isoDate(day: DateTime): string {
  const date = day.toISODate()
  if (date === null) throw new Error(`invalid local date: ${day.toString()}`)
  return date
}

function span(start: DateTime, days: number): LocalWindow {
  return { from: isoDate(start), to: isoDate(start.plus({ days })) }
}

/** "this week" is Monday to Sunday containing today (requirements, relative windows). */
export function relativeWindow(name: WindowName, today: string): LocalWindow {
  const day = localDay(today)
  const monday = day.startOf('week')
  switch (name) {
    case 'today':
      return span(day, 1)
    case 'tomorrow':
      return span(day.plus({ days: 1 }), 1)
    case 'next_3_days':
      return span(day, 3)
    case 'next_7_days':
      return span(day, 7)
    case 'next_14_days':
      return span(day, 14)
    case 'this_week':
      return span(monday, 7)
    case 'next_week':
      return span(monday.plus({ days: 7 }), 7)
  }
}

export function nextDaysWindow(today: string, days: number): LocalWindow {
  return span(localDay(today), days)
}

export function lastMonthsWindow(today: string, months: number): LocalWindow {
  const day = localDay(today)
  return { from: isoDate(day.minus({ months })), to: isoDate(day) }
}

/** UTC instant of local midnight starting `date`. */
export function localMidnight(date: string): string {
  const instant = localDay(date).toUTC().toISO()
  if (instant === null) throw new Error(`invalid local date: ${date}`)
  return instant
}

/** Instant bounds of a local window, for SQL and the availability engine. */
export function windowInstants(window: LocalWindow): { from: string; to: string } {
  return { from: localMidnight(window.from), to: localMidnight(window.to) }
}

/** An instant as ISO-8601 with the America/Chicago offset in force then (R12 e). */
export function presentInstant(value: Date | string): string {
  const parsed =
    value instanceof Date ? DateTime.fromJSDate(value) : DateTime.fromISO(value, { setZone: true })
  const text = parsed.setZone(TIME_ZONE).toISO({ suppressMilliseconds: true })
  if (text === null) throw new Error(`invalid instant: ${String(value)}`)
  return text
}

export function presentOptional(value: Date | string | null): string | null {
  return value === null ? null : presentInstant(value)
}

/** A local window as date-times with offsets, e.g. { from: "2026-11-02T00:00:00-06:00", … }. */
export function presentWindow(window: LocalWindow): { from: string; to: string } {
  const instants = windowInstants(window)
  return { from: presentInstant(instants.from), to: presentInstant(instants.to) }
}

const UTC_INSTANT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z\b/g

/**
 * Rewrites every UTC ("Z") date-time inside free text to its America/Chicago form, so engine
 * reasons show local offsets like every other time. Never apply it to identifiers: a cited ICS
 * occurrence ID ("<UID>@<start>") must stay the stored string (R19, D-141).
 */
export function localizeInstants(text: string): string {
  return text.replace(UTC_INSTANT, (match) => presentInstant(match))
}

export function isLocalDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && DateTime.fromISO(value, { zone: TIME_ZONE }).isValid
}

export function daysBetween(window: LocalWindow): number {
  return localDay(window.to).diff(localDay(window.from), 'days').days
}
