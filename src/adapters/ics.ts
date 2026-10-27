import { DateTime, IANAZone } from 'luxon'
import { TIME_ZONE } from '../config.ts'
import { localDayRange, toInstant } from '../normalize/time.ts'
import { emptyBatch, fileStem, makeIssue, mergeBatches, refFactory, sortByPath } from './shared.ts'
import type {
  AdapterContext,
  CalendarBlockCandidate,
  CandidateBatch,
  IngestIssue,
  ProviderCandidate,
  RawAddress,
  SourceAdapter,
  SourceFile,
  SourceRef,
  TimeBasis,
} from './types.ts'

// A minimal RFC 5545 reader for what calendar exports contain: VEVENTs with DTSTART/DTEND in
// TZID, UTC, floating or DATE form, weekly/daily RRULEs and EXDATEs. Expansion runs in the
// event's own zone, so a 09:00 weekly event stays 09:00 local across the DST change (G17).

interface Property {
  name: string
  params: Record<string, string>
  value: string
}

interface Moment {
  /** Wall-clock time in `zone` (for DATE values, midnight). */
  local: DateTime
  allDay: boolean
  basis: TimeBasis
}

interface Rule {
  freq: string
  interval: number
  byDay: number[]
  until: DateTime | null
  count: number | null
}

const DAY_CODES: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 }

// Summary words that mark a personal block (G17). Work markers are checked first.
const WORK_PREFIX = /^(cxl|job|estimate|est|hold|quote|service|install|repair)\b/i
const PERSONAL =
  /\b(ooo|out of office|vacation|trip|holiday|dentist|doctor|dr\.?|appt|lunch|school|pickup|pick-up|kids?|soccer|baseball|softball|football|practice|recital|birthday|family|personal|gym|truck|maintenance|oil change|haircut|vet|church)\b/i

function unfold(content: string): string[] {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
}

function parseLine(line: string): Property | null {
  const colon = line.indexOf(':')
  if (colon < 0) return null
  const [name = '', ...paramParts] = line.slice(0, colon).split(';')
  const params = Object.fromEntries(
    paramParts.map((part) => {
      const [key = '', value = ''] = part.split('=')
      return [key.toUpperCase(), value.replace(/^"|"$/g, '')]
    }),
  )
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) }
}

function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, char: string) =>
    char.toLowerCase() === 'n' ? '\n' : char,
  )
}

/** Splits the file into calendar properties and one property list per VEVENT. */
function readCalendar(content: string): { calendar: Property[]; events: Property[][] } {
  const calendar: Property[] = []
  const events: Property[][] = []
  const stack: string[] = []
  unfold(content).forEach((line) => {
    const property = parseLine(line)
    if (property === null) return
    if (property.name === 'BEGIN') {
      stack.push(property.value.toUpperCase())
      if (property.value.toUpperCase() === 'VEVENT') events.push([])
      return
    }
    if (property.name === 'END') {
      stack.pop()
      return
    }
    const current = stack[stack.length - 1]
    if (current === 'VCALENDAR') calendar.push(property)
    // Only top-level VEVENT properties; nested VALARMs and VTIMEZONE rules are ignored.
    if (current === 'VEVENT') events[events.length - 1]?.push(property)
  })
  return { calendar, events }
}

function zoneFor(tzid: string | undefined): string | null {
  if (tzid === undefined) return null
  return IANAZone.isValidZone(tzid) ? tzid : null
}

function parseMoment(property: Property): Moment | null {
  const value = property.value.trim()
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value)
  if (property.params['VALUE'] === 'DATE' || date) {
    if (!date) return null
    const local = DateTime.fromObject(
      { year: Number(date[1]), month: Number(date[2]), day: Number(date[3]) },
      { zone: TIME_ZONE },
    )
    return local.isValid ? { local, allDay: true, basis: 'date_only' } : null
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value)
  if (!match) return null
  const fields = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
  }
  if (match[7] === 'Z') {
    const local = DateTime.fromObject(fields, { zone: 'UTC' })
    return local.isValid ? { local, allDay: false, basis: 'utc' } : null
  }
  const tzid = property.params['TZID']
  const zone = zoneFor(tzid) ?? TIME_ZONE
  const local = DateTime.fromObject(fields, { zone })
  if (!local.isValid) return null
  return { local, allDay: false, basis: tzid === undefined ? 'local_assumed' : 'explicit_zone' }
}

function parseRule(value: string): Rule {
  const parts = Object.fromEntries(
    value.split(';').map((part) => {
      const [key = '', val = ''] = part.split('=')
      return [key.toUpperCase(), val]
    }),
  )
  const until = parts['UNTIL']
  const untilMoment =
    until === undefined ? null : parseMoment({ name: 'UNTIL', params: {}, value: until })
  return {
    freq: (parts['FREQ'] ?? '').toUpperCase(),
    interval: Math.max(1, Number(parts['INTERVAL'] ?? 1) || 1),
    byDay: (parts['BYDAY'] ?? '')
      .split(',')
      .map((code) => DAY_CODES[code.trim().toUpperCase().slice(-2)])
      .filter((day): day is number => day !== undefined),
    until: untilMoment === null ? null : untilMoment.local,
    count: parts['COUNT'] === undefined ? null : Number(parts['COUNT']),
  }
}

/**
 * Occurrence starts (wall time in the event's zone) of a DAILY or WEEKLY rule, from DTSTART up
 * to `stop`. Other frequencies return only DTSTART, and the caller reports them.
 */
function expand(start: DateTime, rule: Rule, stop: DateTime): DateTime[] {
  const firstDay = start.startOf('day')
  const weekStart = firstDay.minus({ days: firstDay.weekday - 1 })
  const totalDays = Math.max(0, Math.ceil(stop.diff(firstDay, 'days').days) + 1)
  const days = rule.byDay.length > 0 ? rule.byDay : [start.weekday]
  const occurrences = Array.from({ length: totalDays }, (_, offset) =>
    firstDay.plus({ days: offset }),
  )
    .filter((day) => {
      if (rule.freq === 'DAILY')
        return Math.round(day.diff(firstDay, 'days').days) % rule.interval === 0
      const week = Math.floor(Math.round(day.diff(weekStart, 'days').days) / 7)
      return week % rule.interval === 0 && days.includes(day.weekday)
    })
    .map((day) => day.set({ hour: start.hour, minute: start.minute, second: start.second }))
    .filter((occurrence) => occurrence >= start)
    .filter((occurrence) => rule.until === null || occurrence <= rule.until)
  // DTSTART is always the first occurrence, even when it does not match BYDAY.
  const first = occurrences[0]
  const all = first !== undefined && +first === +start ? occurrences : [start, ...occurrences]
  return rule.count === null ? all : all.slice(0, rule.count)
}

function categoryOf(summary: string | null): CalendarBlockCandidate['category'] {
  if (summary === null) return 'unknown'
  if (WORK_PREFIX.test(summary.trim())) return 'work'
  if (PERSONAL.test(summary)) return 'personal'
  // "<Customer>: <job>" and "<Customer> - <job>" are customer jobs.
  if (/^[^:]+:\s*\S/.test(summary) || /\s-\s/.test(summary)) return 'work'
  return 'unknown'
}

function parseFile(file: SourceFile, ctx: AdapterContext): CandidateBatch {
  const account = fileStem(file.path)
  const providerKey = `ics:${account}`
  const refOf = refFactory('ics', account, file.path, ctx)
  const issues: IngestIssue[] = []
  const { calendar, events } = readCalendar(file.content)
  const calendarName = calendar.find((property) => property.name === 'X-WR-CALNAME')

  const provider: ProviderCandidate = {
    type: 'provider',
    ref: refOf(account),
    providerKey,
    businessName: calendarName === undefined ? account : unescapeText(calendarName.value).trim(),
    ownerName: null,
    phones: [],
    emails: [],
    website: null,
    tradesRaw: [],
    doesNotDoRaw: [],
    declaredServiceZips: null,
    crewSize: null,
    declaredCrm: null,
    baseAddress: null,
  }

  const today = DateTime.fromISO(ctx.today, { zone: TIME_ZONE })
  const windowStart = Date.parse(
    localDayRange(today.minus({ days: ctx.historyDays }).toISODate() ?? ctx.today).startAt,
  )
  const windowEnd = Date.parse(
    localDayRange(today.plus({ days: ctx.horizonDays }).toISODate() ?? ctx.today).startAt,
  )

  const blocks = events.flatMap((properties, index): CalendarBlockCandidate[] => {
    const get = (name: string) => properties.find((property) => property.name === name)
    const uid = get('UID')?.value.trim() || `event-${String(index + 1)}`
    const eventRef: SourceRef = refOf(uid)
    const dtStart = get('DTSTART')
    const start = dtStart === undefined ? null : parseMoment(dtStart)
    if (start === null) {
      issues.push(
        makeIssue(eventRef, 'warn', 'ics.bad_dtstart', 'Event without a readable DTSTART skipped'),
      )
      return []
    }
    if (dtStart?.params['TZID'] !== undefined && zoneFor(dtStart.params['TZID']) === null) {
      issues.push(
        makeIssue(eventRef, 'warn', 'ics.unknown_tzid', 'Unknown TZID read as America/Chicago'),
      )
    }
    if (get('RECURRENCE-ID') !== undefined) {
      issues.push(
        makeIssue(
          eventRef,
          'warn',
          'ics.recurrence_id',
          'RECURRENCE-ID override kept as its own event',
        ),
      )
    }

    const dtEnd = get('DTEND')
    const end = dtEnd === undefined ? null : parseMoment(dtEnd)
    // Exclusive DATE end for all-day events; a timed event keeps its exact length.
    const allDayLength =
      start.allDay && end !== null
        ? Math.max(1, Math.round(end.local.diff(start.local, 'days').days))
        : 1
    const timedLengthMs =
      !start.allDay && end !== null ? Math.max(0, end.local.toMillis() - start.local.toMillis()) : 0
    if (!start.allDay && end === null) {
      issues.push(
        makeIssue(
          eventRef,
          'warn',
          'ics.no_dtend',
          'Timed event without DTEND kept as zero length',
        ),
      )
    }

    const summaryProperty = get('SUMMARY')
    const summary =
      summaryProperty === undefined ? null : unescapeText(summaryProperty.value).trim() || null
    const status = get('STATUS')?.value.trim().toUpperCase()
    const transparent = get('TRANSP')?.value.trim().toUpperCase() === 'TRANSPARENT'
    // D-036: CXL prefix, CANCELLED and TRANSPARENT never block time; TENTATIVE does.
    const cancelledJob = summary !== null && /^cxl\b/i.test(summary)
    const busy = !(transparent || status === 'CANCELLED' || cancelledJob)
    // G17, D-079: the engine's BusyStatus vocabulary; a missing or unknown STATUS is confirmed.
    const blockStatus =
      status === 'TENTATIVE' ? 'tentative' : status === 'CANCELLED' ? 'cancelled' : 'confirmed'
    const locationProperty = get('LOCATION')
    const locationText =
      locationProperty === undefined ? null : unescapeText(locationProperty.value).trim() || null
    // G18, D-085: kept as free text; the pipeline maps it to a property.
    const location: RawAddress | null =
      locationText === null
        ? null
        : { line1: null, line2: null, city: null, state: null, zip: null, freeText: locationText }

    const rruleProperty = get('RRULE')
    const rule = rruleProperty === undefined ? null : parseRule(rruleProperty.value)
    if (rule !== null && rule.freq !== 'WEEKLY' && rule.freq !== 'DAILY') {
      issues.push(
        makeIssue(
          eventRef,
          'warn',
          'ics.unsupported_rrule',
          `FREQ=${rule.freq} not expanded; first occurrence only`,
        ),
      )
    }
    const exdates = new Set(
      properties
        .filter((property) => property.name === 'EXDATE')
        .flatMap((property) =>
          property.value.split(',').map((value) => parseMoment({ ...property, value })),
        )
        .filter((moment): moment is Moment => moment !== null)
        .map((moment) => (moment.allDay ? moment.local.toISODate() : moment.local.toMillis())),
    )
    const stop = DateTime.fromMillis(windowEnd, { zone: start.local.zone })
    const starts =
      rule === null || (rule.freq !== 'WEEKLY' && rule.freq !== 'DAILY')
        ? [start.local]
        : expand(start.local, rule, stop)

    return starts
      .filter((local) => !exdates.has(start.allDay ? local.toISODate() : local.toMillis()))
      .flatMap((local): CalendarBlockCandidate[] => {
        const startDt = start.allDay ? local.startOf('day') : local
        const endDt = start.allDay
          ? startDt.plus({ days: allDayLength })
          : startDt.plus({ milliseconds: timedLengthMs })
        const startAt = toInstant(startDt)
        const endAt = toInstant(endDt)
        if (startAt === null || endAt === null) return []
        const startMs = Date.parse(startAt)
        if (startMs < windowStart || startMs >= windowEnd) return []
        return [
          {
            type: 'calendar_block',
            ref: refOf(`${uid}@${startAt}`),
            providerKey,
            startAt,
            endAt,
            allDay: start.allDay,
            timeBasis: start.basis,
            busy,
            status: blockStatus,
            category: cancelledJob ? 'work' : categoryOf(summary),
            summaryRaw: summary,
            location,
            recurrence:
              rule === null || rruleProperty === undefined
                ? null
                : { masterUid: uid, rrule: rruleProperty.value.trim() },
          },
        ]
      })
  })

  return { ...emptyBatch(), providers: [provider], calendarBlocks: blocks, issues }
}

/** Calendar exports: one provider per calendar, one busy/free block per occurrence in the window. */
export const icsAdapter: SourceAdapter = {
  sourceSystem: 'ics',
  patterns: ['sources/calendars/*.ics'],
  parse(files, ctx) {
    return mergeBatches(sortByPath(files).map((file) => parseFile(file, ctx)))
  },
}
