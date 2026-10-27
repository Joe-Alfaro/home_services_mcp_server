import { parse } from 'csv-parse/sync'
import { DateTime } from 'luxon'
import { TIME_ZONE } from '../config.ts'
import { dollarsToCents } from '../normalize/money.ts'
import { applyLimboRule } from '../normalize/status.ts'
import { isAmbiguousLocal, localDayRange, localToInstant } from '../normalize/time.ts'
import {
  compact,
  emptyBatch,
  fileStem,
  makeIssue,
  mergeBatches,
  refFactory,
  rescheduleNoteOf,
  rescheduledFromOf,
  sortByPath,
} from './shared.ts'
import type {
  AdapterContext,
  CandidateBatch,
  IngestIssue,
  Instant,
  JobCandidate,
  JobStatus,
  LocalDate,
  PropertyCandidate,
  ProviderCandidate,
  SourceAdapter,
  SourceFile,
  SourceRef,
  TimeBasis,
} from './types.ts'

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
// ISO weekday (1 = Monday) by prefix; "thurs", "tues", "weds" and full names all match.
const WEEKDAYS: ReadonlyArray<[RegExp, number]> = [
  [/^mon(day)?$/, 1],
  [/^tue(s|sday)?$/, 2],
  [/^wed(s|nesday)?$/, 3],
  [/^thu(r|rs|rsday)?$/, 4],
  [/^fri(day)?$/, 5],
  [/^sat(urday)?$/, 6],
  [/^sun(day)?$/, 7],
]

/** How a Date cell was written, before years are inferred from neighbouring rows. */
type DateCell =
  | { form: 'full'; date: DateTime }
  | { form: 'month_day'; month: number; day: number }
  | { form: 'weekday'; weekday: number }
  | { form: 'invalid' }
  | { form: 'blank' }

interface Row {
  line: number
  cells: Record<string, string | null>
  dateCell: DateCell
}

function weekdayOf(word: string): number | null {
  const lower = word.toLowerCase().replace(/\.$/, '')
  const found = WEEKDAYS.find(([pattern]) => pattern.test(lower))
  return found === undefined ? null : found[1]
}

function calendarDate(year: number, month: number, day: number): DateTime | null {
  const date = DateTime.fromObject({ year, month, day }, { zone: TIME_ZONE })
  return date.isValid && date.month === month && date.day === day ? date : null
}

function monthDay(month: number, day: number): DateCell {
  // Validate against a leap year so 2/29 survives until the year is known.
  return calendarDate(2024, month, day) === null
    ? { form: 'invalid' }
    : { form: 'month_day', month, day }
}

/** Reads every Date form in the log (G16). Numeric dates are always month-first. */
function parseDateCell(raw: string | null): DateCell {
  if (raw === null) return { form: 'blank' }
  const text = raw.trim().replace(/\s+/g, ' ')
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text)
  if (iso) {
    const date = calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))
    return date === null ? { form: 'invalid' } : { form: 'full', date }
  }
  const numeric = /^(?:[a-z]+\.? )?(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/i.exec(text)
  if (numeric) {
    const month = Number(numeric[1])
    const day = Number(numeric[2])
    if (numeric[3] === undefined) return monthDay(month, day)
    const year = numeric[3].length === 2 ? 2000 + Number(numeric[3]) : Number(numeric[3])
    const date = calendarDate(year, month, day)
    return date === null ? { form: 'invalid' } : { form: 'full', date }
  }
  const named = /^([a-z]{3,9})\.? (\d{1,2})$/i.exec(text)
  if (named?.[1] !== undefined) {
    const month = MONTHS.indexOf(named[1].slice(0, 3).toLowerCase()) + 1
    if (month > 0) return monthDay(month, Number(named[2]))
  }
  const relative = /^(?:next )?([a-z]+\.?)$/i.exec(text)
  if (relative?.[1] !== undefined) {
    const weekday = weekdayOf(relative[1])
    if (weekday !== null) return { form: 'weekday', weekday }
  }
  return { form: 'invalid' }
}

/** The first such weekday after the export date (D-034): "Mon" from Fri 10/30 is 11/2. */
function nextWeekday(exportDate: DateTime, weekday: number): DateTime {
  const ahead = (weekday - exportDate.weekday + 7) % 7
  return exportDate.plus({ days: ahead === 0 ? 7 : ahead })
}

/** Picks the year that puts a year-less date closest to its nearest dated neighbour (D-034). */
function nearestYear(month: number, day: number, anchor: DateTime): DateTime | null {
  const candidates = compact(
    [anchor.year - 1, anchor.year, anchor.year + 1].map(
      (year) => calendarDate(year, month, day)?.toISODate() ?? null,
    ),
  ).map((iso) => DateTime.fromISO(iso, { zone: TIME_ZONE }))
  return candidates.reduce<DateTime | null>((best, candidate) => {
    if (best === null) return candidate
    const distance = (date: DateTime) => Math.abs(date.diff(anchor, 'days').days)
    return distance(candidate) < distance(best) ? candidate : best
  }, null)
}

/** Resolves every row's date: full dates and weekdays first, then year-less dates in order. */
function resolveDates(rows: readonly Row[], exportDate: DateTime): Array<DateTime | null> {
  const direct = rows.map((row) => {
    if (row.dateCell.form === 'full') return row.dateCell.date
    if (row.dateCell.form === 'weekday') return nextWeekday(exportDate, row.dateCell.weekday)
    return null
  })
  return rows.reduce<Array<DateTime | null>>((resolved, row, index) => {
    const cell = row.dateCell
    if (cell.form !== 'month_day') return [...resolved, direct[index] ?? null]
    const previous = [...resolved].reverse().find((date) => date !== null)
    const next = direct.slice(index + 1).find((date) => date !== null)
    const anchor = previous ?? next ?? exportDate
    return [...resolved, nearestYear(cell.month, cell.day, anchor)]
  }, [])
}

/** "9:30am", "3pm", "14:00", "8:15"; bare 1:00-6:59 is afternoon (D-034). Null when unparseable. */
function parseTime(raw: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?\.?$/i.exec(raw.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2] ?? 0)
  const meridiem = match[3]?.toLowerCase().charAt(0)
  if (minute > 59) return null
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return null
    return { hour: (hour % 12) + (meridiem === 'p' ? 12 : 0), minute }
  }
  if (hour > 23) return null
  return { hour: hour >= 1 && hour <= 6 ? hour + 12 : hour, minute }
}

/** Notes carry the only status in the log (D-035). Other notes are informational. */
function statusFromNote(note: string | null): JobStatus | null {
  if (note === null) return null
  const lower = note.toLowerCase()
  if (/\b(cancell?ed|cxl)\b/.test(lower)) return 'cancelled'
  if (/waiting (on|for) parts/.test(lower)) return 'on_hold'
  if (/need(s)? to reschedule/.test(lower)) return 'unscheduled'
  return null
}

interface CsvRecord {
  record: string[]
  info: { lines: number }
}

function readCsv(content: string): CsvRecord[] | null {
  try {
    // With `info: true`, csv-parse returns { record, info } objects; its types do not say so.
    return parse(content, {
      info: true,
      relax_column_count: true,
      skip_empty_lines: true,
      bom: true,
    }) as unknown as CsvRecord[]
  } catch {
    return null
  }
}

interface Slot {
  startAt: Instant | null
  endAt: Instant | null
  timeBasis: TimeBasis | null
  allDay: boolean
}

/** A row's slot. With no readable time the row is date-only and covers its local day (D-055). */
function slotOf(
  isoDate: LocalDate | null,
  rawTime: string | null,
  ref: SourceRef,
  issues: IngestIssue[],
): Slot {
  if (isoDate === null) return { startAt: null, endAt: null, timeBasis: null, allDay: false }
  const time = rawTime === null ? null : parseTime(rawTime)
  if (rawTime !== null && time === null) {
    issues.push(
      makeIssue(
        ref,
        'warn',
        'csv.unparseable_time',
        'Time could not be read; row kept as date-only',
      ),
    )
  }
  if (time === null) {
    const day = localDayRange(isoDate)
    return { startAt: day.startAt, endAt: day.endAt, timeBasis: 'date_only', allDay: true }
  }
  const local = `${isoDate}T${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`
  if (isAmbiguousLocal(local)) {
    issues.push(
      makeIssue(
        ref,
        'info',
        'time.ambiguous_local',
        'Time falls in the repeated fall-back hour; read as the earlier instant',
      ),
    )
  }
  return { startAt: localToInstant(local), endAt: null, timeBasis: 'local_assumed', allDay: false }
}

function rowKey(cells: Record<string, string | null>): string {
  return JSON.stringify(Object.values(cells))
}

function parseFile(file: SourceFile, ctx: AdapterContext): CandidateBatch {
  const account = fileStem(file.path)
  const providerKey = `spreadsheet:${account}`
  const refOf = refFactory('spreadsheet', account, file.path, ctx)
  const issues: IngestIssue[] = []

  const records = readCsv(file.content)
  if (records === null) {
    issues.push(makeIssue(refOf(account), 'error', 'csv.unparseable', 'The file is not valid CSV'))
    return { ...emptyBatch(), issues }
  }
  const withLines = records.map(({ record, info }) => ({
    record,
    // info.lines is where the record ends; quoted newlines push it past the start line.
    line: info.lines - record.join('').split('\n').length + 1,
  }))

  const headerIndex = withLines.findIndex(
    ({ record }) =>
      record[0]?.trim().toLowerCase() === 'date' &&
      record.some((cell) => cell.trim().toLowerCase() === 'job'),
  )
  if (headerIndex < 0) {
    issues.push(
      makeIssue(refOf(account), 'error', 'csv.no_header', 'No header row with Date and Job'),
    )
    return { ...emptyBatch(), issues }
  }
  const preamble = withLines.slice(0, headerIndex).map(({ record }) => record.join(' ').trim())
  const header = (withLines[headerIndex]?.record ?? []).map((cell) => cell.trim())

  const titleLine = withLines[0]
  const title = headerIndex > 0 ? (titleLine?.record[0]?.trim() ?? '') : ''
  const businessName = title.replace(/\s*[-–]\s*job log\s*$/i, '').trim() || account
  const provider: ProviderCandidate = {
    type: 'provider',
    ref: refOf(headerIndex > 0 ? `row:${String(titleLine?.line ?? 1)}` : account),
    providerKey,
    businessName,
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

  const exportMatch = preamble
    .map((text) => /exported\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i.exec(text))
    .find((match) => match !== null)
  const exportYear = exportMatch?.[3]
  const exportDate =
    exportMatch && exportYear !== undefined
      ? calendarDate(
          exportYear.length === 2 ? 2000 + Number(exportYear) : Number(exportYear),
          Number(exportMatch[1]),
          Number(exportMatch[2]),
        )
      : null
  const anchorDate = exportDate ?? DateTime.fromISO(ctx.today, { zone: TIME_ZONE })
  if (exportDate === null) {
    issues.push(
      makeIssue(
        provider.ref,
        'warn',
        'csv.no_export_date',
        'No export date in the preamble; using today',
      ),
    )
  }
  const exportDay: LocalDate = anchorDate.toISODate() ?? ctx.today

  const rows: Row[] = withLines.slice(headerIndex + 1).map(({ record, line }) => {
    const cells = Object.fromEntries(
      header.map((name, index) => {
        const value = record[index]?.trim() ?? ''
        return [name, value === '' ? null : value]
      }),
    )
    return { line, cells, dateCell: parseDateCell(cells['Date'] ?? null) }
  })
  const dates = resolveDates(rows, anchorDate)

  // One property per distinct free-text address, keyed by its first row; contact from its
  // latest row, since rows are chronological and later rows carry the current details.
  const properties = new Map<string, PropertyCandidate>()
  const seenRows = new Map<string, number>()

  function rememberProperty(
    address: string,
    recordId: string,
    cell: (name: string) => string | null,
  ): string {
    const existing = properties.get(address)
    const ref = existing?.ref ?? refOf(`${recordId}#address`)
    const propertyKey = existing?.propertyKey ?? `${providerKey}:${ref.sourceRecordId}`
    properties.set(address, {
      type: 'property',
      ref,
      propertyKey,
      providerKey,
      address: { line1: null, line2: null, city: null, state: null, zip: null, freeText: address },
      contact: {
        sourceCustomerId: null,
        name: cell('Customer'),
        phones: compact([cell('Phone')]),
        emails: [],
      },
    })
    return propertyKey
  }

  const jobs = rows.map((row, index): JobCandidate => {
    const recordId = `row:${String(row.line)}`
    const ref: SourceRef = refOf(recordId)
    const { cells } = row
    const cell = (name: string) => cells[name] ?? null

    const repeatOf = seenRows.get(rowKey(cells))
    if (repeatOf !== undefined) {
      issues.push(
        makeIssue(ref, 'info', 'csv.duplicate_row', `${recordId} repeats row:${String(repeatOf)}`),
      )
    } else {
      seenRows.set(rowKey(cells), row.line)
    }

    const address = cell('Address')
    const propertyKey = address === null ? null : rememberProperty(address, recordId, cell)

    const date = dates[index] ?? null
    if (row.dateCell.form === 'invalid' || row.dateCell.form === 'blank') {
      issues.push(
        makeIssue(
          ref,
          'warn',
          row.dateCell.form === 'blank' ? 'csv.blank_date' : 'csv.unparseable_date',
          'Date could not be read; row kept with no slot',
        ),
      )
    }
    const isoDate = date?.toISODate() ?? null
    const { startAt, endAt, timeBasis, allDay } = slotOf(isoDate, cell('Time'), ref, issues)

    const note = cell('Notes')
    const noteStatus = statusFromNote(note)
    // Blank or informational note: before the export date it happened; after it, it was booked.
    const dated = isoDate === null ? null : isoDate < exportDay ? 'completed' : 'scheduled'
    const baseStatus: JobStatus = noteStatus ?? dated ?? 'limbo'
    const amountRaw = cell('$')
    const amountCents = dollarsToCents(amountRaw)
    if (amountRaw !== null && amountCents === null) {
      issues.push(makeIssue(ref, 'warn', 'money.unparseable', 'Unparseable $ cell; left unknown'))
    }
    const jobText = cell('Job')
    return {
      type: 'job',
      ref,
      kind: jobText !== null && /^estimate\b/i.test(jobText) ? 'estimate' : 'job',
      providerKey,
      propertyKey,
      parentSourceRecordId: null,
      statusRaw: note ?? '',
      status: applyLimboRule(baseStatus, { startAt, endAt: allDay ? endAt : null }, ctx.now),
      startAt,
      endAt,
      allDay,
      timeBasis,
      completedAt: null,
      sourceCreatedAt: null,
      sourceUpdatedAt: null,
      tradeRaw: jobText,
      descriptionRaw: jobText,
      notesRaw: note,
      amountCents,
      amountRaw,
      isRecurring: false,
      rescheduleNote: rescheduleNoteOf(note),
      rescheduledFrom: rescheduledFromOf(rescheduleNoteOf(note), isoDate),
    }
  })

  return {
    ...emptyBatch(),
    providers: [provider],
    properties: [...properties.values()],
    jobs,
    issues,
  }
}

/** The hand-kept CSV job log: one provider per file, named from its title row. */
export const spreadsheetAdapter: SourceAdapter = {
  sourceSystem: 'spreadsheet',
  patterns: ['sources/spreadsheet/*.csv'],
  parse(files, ctx) {
    return mergeBatches(sortByPath(files).map((file) => parseFile(file, ctx)))
  },
}
