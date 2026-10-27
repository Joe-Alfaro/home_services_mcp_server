import type { DeclaredHoursCandidate } from '../adapters/types.ts'

type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7
type Window = DeclaredHoursCandidate['weekly'][number]

export interface ParsedHours {
  weekly: Window[]
  parsed: DeclaredHoursCandidate['parsed']
  /** True for "24/7"-style hours: every day, all day, but not a usable working pattern (G20). */
  alwaysOpen: boolean
}

const ALL_DAYS: Weekday[] = [1, 2, 3, 4, 5, 6, 7]

const DAY_WORDS: ReadonlyArray<[RegExp, Weekday]> = [
  [/^(m|mo|mon|monday)$/, 1],
  [/^(tu|tue|tues|tuesday)$/, 2],
  [/^(w|we|wed|weds|wednesday)$/, 3],
  [/^(th|thu|thur|thurs|thursday)$/, 4],
  [/^(f|fr|fri|friday)$/, 5],
  [/^(sa|sat|saturday)$/, 6],
  [/^(su|sun|sunday)$/, 7],
]

function dayOf(word: string): Weekday | null {
  const lower = word.trim().toLowerCase().replace(/\.$/, '')
  return DAY_WORDS.find(([pattern]) => pattern.test(lower))?.[1] ?? null
}

/** "Mon-Fri", "M-F", "Weekdays", "Sat", "Saturday", "Mon-Sat", "Weekends". */
function parseDays(text: string): Weekday[] | null {
  const lower = text.trim().toLowerCase()
  if (/^(weekdays?|mon-fri)$/.test(lower)) return [1, 2, 3, 4, 5]
  if (/^weekends?$/.test(lower)) return [6, 7]
  if (/^(daily|every ?day|7 days)$/.test(lower)) return ALL_DAYS
  const range = /^([a-z.]+)\s*-\s*([a-z.]+)$/.exec(lower)
  if (range?.[1] !== undefined && range[2] !== undefined) {
    const from = dayOf(range[1])
    const to = dayOf(range[2])
    if (from === null || to === null) return null
    // "Sun-Thu" and "Fri-Mon" wrap past Sunday (G20).
    return ALL_DAYS.filter((day) =>
      from <= to ? day >= from && day <= to : day >= from || day <= to,
    )
  }
  const single = dayOf(lower)
  return single === null ? null : [single]
}

interface ClockTime {
  hour: number
  minute: number
  meridiem: 'a' | 'p' | null
}

function parseClock(text: string): ClockTime | null {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/i.exec(text.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2] ?? 0)
  const meridiem = (match[3]?.toLowerCase().charAt(0) ?? null) as ClockTime['meridiem']
  if (minute > 59 || hour > 24 || (meridiem !== null && (hour < 1 || hour > 12))) return null
  return { hour, minute, meridiem }
}

function to24(time: ClockTime): number {
  if (time.meridiem === null) return time.hour
  return (time.hour % 12) + (time.meridiem === 'p' ? 12 : 0)
}

function hhmm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** "8am-5pm", "07:00-18:00", "8-5" (a bare end at or before the start is afternoon). */
function parseRange(text: string): { start: string; end: string } | null {
  const [fromText, toText, ...rest] = text.split(/\s*[-–]\s*/)
  if (fromText === undefined || toText === undefined || rest.length > 0) return null
  const from = parseClock(fromText)
  const to = parseClock(toText)
  if (from === null || to === null) return null
  const startHour = to24(from)
  let endHour = to24(to)
  if (to.meridiem === null && endHour * 60 + to.minute <= startHour * 60 + from.minute)
    endHour += 12
  if (endHour * 60 + to.minute <= startHour * 60 + from.minute || endHour > 24) return null
  return { start: hhmm(startHour, from.minute), end: hhmm(endHour, to.minute) }
}

/** One "<days> <range>" segment; "closed weekends" parses to no windows. */
function parseSegment(segment: string): Window[] | null {
  const text = segment.trim()
  if (text === '') return []
  if (/^closed\b/i.test(text) || /\bclosed$/i.test(text))
    return parseDays(text.replace(/closed/i, '').trim()) === null ? null : []
  const match =
    /^(.+?)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?\s*[-–]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?)$/i.exec(
      text,
    )
  if (!match?.[1] || !match[2]) return null
  const days = parseDays(match[1])
  const range = parseRange(match[2])
  if (days === null || range === null) return null
  return days.map((weekday) => ({ weekday, ...range }))
}

function sortWindows(windows: Window[]): Window[] {
  return [...windows].sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start))
}

function finish(results: Array<Window[] | null>, alwaysOpen = false): ParsedHours {
  const parsedSegments = results.filter((result): result is Window[] => result !== null)
  const weekly = sortWindows(parsedSegments.flat())
  if (parsedSegments.length === 0) return { weekly: [], parsed: 'none', alwaysOpen }
  return {
    weekly,
    parsed: parsedSegments.length === results.length ? 'full' : 'partial',
    alwaysOpen,
  }
}

/**
 * Parses free-form declared hours (G20): strings such as "Mon-Fri 8am-5pm, Sat 9am-1pm",
 * "Weekdays 07:00-18:00 / Saturday 08:00-14:00" and "M-F 8-5", or a per-day dictionary
 * {"mon": "08:00-17:00", "sun": "closed"}. Unparseable text gives `parsed: 'none'`.
 */
export function parseDeclaredHours(raw: unknown): ParsedHours {
  if (typeof raw === 'string') {
    if (/24\s*\/\s*7/.test(raw)) {
      return finish([ALL_DAYS.map((weekday) => ({ weekday, start: '00:00', end: '24:00' }))], true)
    }
    return finish(
      raw
        .split(/\s*[,/;]\s*/)
        .filter((segment) => segment.trim() !== '')
        .map(parseSegment),
    )
  }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return finish(
      Object.entries(raw).map(([key, value]): Window[] | null => {
        const weekday = dayOf(key)
        if (weekday === null || typeof value !== 'string') return null
        if (/^\s*(closed|off|none|-)?\s*$/i.test(value)) return []
        const range = parseRange(value)
        return range === null ? null : [{ weekday, ...range }]
      }),
    )
  }
  return { weekly: [], parsed: 'none', alwaysOpen: false }
}
