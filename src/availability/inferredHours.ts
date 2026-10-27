import type { HistoryItem, Instant, WeeklyHours } from './engine.ts'
import { formatMinuteOfDay, localDateTime, localDateKey, minuteOfDay } from './time.ts'

const DEFAULT_LOOKBACK_DAYS = 90
const DAY_MS = 24 * 60 * 60_000

interface DaySpan {
  start: number
  end: number
}

/**
 * R13(e): weekly hours inferred from observed work. For each Chicago weekday, the earliest local
 * start and the latest local end of items that start in [now - lookbackDays, now). Items without
 * an end are ignored. An item that runs past local midnight ends the day at 24:00.
 */
export function inferWeeklyHours(
  history: readonly HistoryItem[],
  options: { now: Instant; lookbackDays?: number },
): WeeklyHours[] {
  const nowMs = Date.parse(options.now)
  const fromMs = nowMs - (options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS) * DAY_MS

  const byWeekday = history.reduce((days, item) => {
    if (item.endAt === null) return days
    const startMs = Date.parse(item.startAt)
    if (startMs < fromMs || startMs >= nowMs) return days
    const start = localDateTime(startMs)
    const weekday = start.weekday as WeeklyHours['weekday']
    const end = localDateTime(Date.parse(item.endAt))
    const span = {
      start: minuteOfDay(start),
      end: localDateKey(end) === localDateKey(start) ? minuteOfDay(end) : 24 * 60,
    }
    const seen = days.get(weekday)
    days.set(
      weekday,
      seen === undefined
        ? span
        : { start: Math.min(seen.start, span.start), end: Math.max(seen.end, span.end) },
    )
    return days
  }, new Map<WeeklyHours['weekday'], DaySpan>())

  return [...byWeekday.entries()]
    .sort(([a], [b]) => a - b)
    .map(([weekday, span]) => ({
      weekday,
      start: formatMinuteOfDay(span.start),
      end: formatMinuteOfDay(span.end),
    }))
}
