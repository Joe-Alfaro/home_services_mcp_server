import type {
  AdapterContext,
  CandidateBatch,
  IngestIssue,
  Instant,
  JobCandidate,
  JobStatus,
  LocalDate,
  SourceFile,
  SourceRef,
  SourceSystem,
} from './types.ts'
import { DateTime } from 'luxon'
import { applyLimboRule } from '../normalize/status.ts'
import { isAmbiguousLocal, localDateOf, localToInstant } from '../normalize/time.ts'

export function emptyBatch(): CandidateBatch {
  return {
    providers: [],
    properties: [],
    jobs: [],
    calendarBlocks: [],
    declaredHours: [],
    issues: [],
  }
}

export function mergeBatches(batches: readonly CandidateBatch[]): CandidateBatch {
  return batches.reduce<CandidateBatch>(
    (all, batch) => ({
      providers: [...all.providers, ...batch.providers],
      properties: [...all.properties, ...batch.properties],
      jobs: [...all.jobs, ...batch.jobs],
      calendarBlocks: [...all.calendarBlocks, ...batch.calendarBlocks],
      declaredHours: [...all.declaredHours, ...batch.declaredHours],
      issues: [...all.issues, ...batch.issues],
    }),
    emptyBatch(),
  )
}

/** Builds the SourceRef for records of one file. */
export function refFactory(
  sourceSystem: SourceSystem,
  sourceAccount: string,
  sourceFile: string,
  ctx: AdapterContext,
): (sourceRecordId: string) => SourceRef {
  return (sourceRecordId) => ({
    sourceSystem,
    sourceAccount,
    sourceFile,
    sourceRecordId,
    ingestedAt: ctx.ingestedAt,
  })
}

/** Issue messages carry IDs, file names and codes only, never PII values. */
export function makeIssue(
  ref: SourceRef,
  severity: IngestIssue['severity'],
  code: string,
  message: string,
): IngestIssue {
  return { ref, severity, code, message }
}

export function fileName(path: string): string {
  return path.split('/').pop() ?? path
}

export function fileStem(path: string): string {
  return fileName(path).replace(/\.[^.]+$/, '')
}

/** The folder directly under `sources/<dir>/` for account-per-folder sources. */
export function accountFolder(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 2] ?? ''
}

/** Groups files by a key, preserving no particular order (callers sort). */
export function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  return items.reduce((groups, item) => {
    const key = keyOf(item)
    groups.set(key, [...(groups.get(key) ?? []), item])
    return groups
  }, new Map<string, T[]>())
}

export function sortByPath(files: readonly SourceFile[]): SourceFile[] {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Parses JSON, or records an error issue and returns null. */
export function parseJsonFile(file: SourceFile, ref: SourceRef, issues: IngestIssue[]): unknown {
  try {
    return JSON.parse(file.content) as unknown
  } catch {
    issues.push(
      makeIssue(ref, 'error', 'file.invalid_json', `${fileName(file.path)} is not valid JSON`),
    )
    return null
  }
}

// --- narrowing helpers for untyped JSON -------------------------------------------------------

export type JsonObject = Record<string, unknown>

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function objectAt(value: unknown, key: string): JsonObject | null {
  if (!isObject(value)) return null
  const child = value[key]
  return isObject(child) ? child : null
}

export function arrayAt(value: unknown, key: string): unknown[] {
  if (!isObject(value)) return []
  const child = value[key]
  return Array.isArray(child) ? child : []
}

/** A trimmed non-empty string, or null ("" and whitespace become null). */
export function textAt(value: unknown, key: string): string | null {
  if (!isObject(value)) return null
  const child = value[key]
  if (typeof child === 'number') return String(child)
  if (typeof child !== 'string') return null
  const trimmed = child.trim()
  return trimmed === '' ? null : trimmed
}

export function numberAt(value: unknown, key: string): number | null {
  if (!isObject(value)) return null
  const child = value[key]
  return typeof child === 'number' && Number.isFinite(child) ? child : null
}

export function nullIfBlank(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export function compact(values: readonly (string | null)[]): string[] {
  return values.filter((value): value is string => value !== null)
}

export function joinName(first: string | null, last: string | null): string | null {
  return nullIfBlank(compact([first, last]).join(' '))
}

/**
 * "Rescheduled from M/D per customer" notes are kept as reschedule evidence (G9). A to-do such as
 * "need to reschedule" says nothing has moved yet, so it is not evidence.
 */
export function rescheduleNoteOf(note: string | null): string | null {
  return note !== null && /\brescheduled\b/i.test(note) ? note : null
}

/**
 * The local date a job moved from, read from "Rescheduled from M/D". The note has no year, so the
 * year is the latest one that puts M/D on or before the job's own local date (G9, D-078).
 */
export function rescheduledFromOf(
  note: string | null,
  jobDate: LocalDate | null,
): LocalDate | null {
  if (note === null || jobDate === null) return null
  const match = /\brescheduled\s+from\s+(\d{1,2})\/(\d{1,2})\b/i.exec(note)
  if (match === null) return null
  const [month, day] = [Number(match[1]), Number(match[2])]
  const jobYear = Number(jobDate.slice(0, 4))
  const candidate = (year: number) => DateTime.fromObject({ year, month, day }).toISODate()
  const sameYear = candidate(jobYear)
  if (sameYear === null) return null
  return sameYear <= jobDate ? sameYear : candidate(jobYear - 1)
}

// --- status ------------------------------------------------------------------------------------

/**
 * Looks a raw status up in an adapter's table. Unknown values map to limbo with a
 * `status.unmapped` warning (R9), so setup can report them without dropping the record.
 */
export function mapStatus(
  table: ReadonlyMap<string, JobStatus>,
  raw: string,
  ref: SourceRef,
  issues: IngestIssue[],
): JobStatus {
  const status = table.get(raw.trim().toLowerCase())
  if (status !== undefined) return status
  issues.push(makeIssue(ref, 'warn', 'status.unmapped', `Unknown status "${raw}" mapped to limbo`))
  return 'limbo'
}

export function statusTable(entries: Record<string, JobStatus>): ReadonlyMap<string, JobStatus> {
  return new Map(Object.entries(entries).map(([raw, status]) => [raw.toLowerCase(), status]))
}

// --- time ----------------------------------------------------------------------------------------

/** Reads a zone-less local time and flags the repeated fall-back hour (D-031). */
export function localTime(
  raw: string | null,
  field: string,
  ref: SourceRef,
  issues: IngestIssue[],
): Instant | null {
  if (raw === null) return null
  const instant = localToInstant(raw)
  if (instant === null) {
    issues.push(makeIssue(ref, 'warn', 'time.unparseable', `Unparseable ${field}; left empty`))
    return null
  }
  if (isAmbiguousLocal(raw)) {
    issues.push(
      makeIssue(
        ref,
        'info',
        'time.ambiguous_local',
        `${field} falls in the repeated fall-back hour; read as the earlier (daylight) instant`,
      ),
    )
  }
  return instant
}

/** Shared sanity checks and the limbo rule, applied to every CRM-style job candidate. */
export function finishJob(
  job: JobCandidate,
  ctx: AdapterContext,
  issues: IngestIssue[],
): JobCandidate {
  const { startAt, endAt } = job
  if (startAt !== null && endAt !== null && Date.parse(endAt) < Date.parse(startAt)) {
    issues.push(makeIssue(job.ref, 'warn', 'time.end_before_start', 'End is before start'))
  }
  if (
    startAt !== null &&
    endAt !== null &&
    Date.parse(endAt) - Date.parse(startAt) > 12 * 3_600_000
  ) {
    issues.push(makeIssue(job.ref, 'info', 'time.long_span', 'Slot spans more than 12 hours'))
  }
  // G10, D-038: completed work dated after today stays completed (history) but is flagged.
  if (job.status === 'completed' && startAt !== null && localDateOf(startAt) > ctx.today) {
    issues.push(
      makeIssue(job.ref, 'warn', 'time.suspect_date', 'Completed item is dated after today'),
    )
  }
  return {
    ...job,
    status: applyLimboRule(job.status, { startAt, endAt }, ctx.now),
    rescheduledFrom: rescheduledFromOf(
      job.rescheduleNote,
      startAt === null ? null : localDateOf(startAt),
    ),
  }
}
