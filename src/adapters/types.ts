// The adapter contract from ARCHITECTURE.md. Adapters are pure: parse(files, ctx) → CandidateBatch.

export type SourceSystem =
  | 'jobber' // CRM A
  | 'housecall_pro' // CRM B
  | 'workiz' // CRM C
  | 'spreadsheet' // CSV job log
  | 'ics' // calendars
  | 'profiles' // provider profiles

/** ISO-8601 instant in UTC, always with a trailing "Z", e.g. "2026-11-02T15:00:00Z". */
export type Instant = string
/** Local calendar date "YYYY-MM-DD" in America/Chicago. */
export type LocalDate = string

/** Provenance carried by every candidate (R11, R19). */
export interface SourceRef {
  sourceSystem: SourceSystem
  /** Account folder or file stem, e.g. "lone_star_plumbing", "rays_fixit_job_log". */
  sourceAccount: string
  /** Path relative to DATA_PACK_DIR with "/" separators, e.g. "sources/workiz/lone_star_plumbing/jobs.json". */
  sourceFile: string
  /**
   * Native record ID. Conventions where none exists:
   * CSV: "row:<1-based physical line number>";
   * ICS occurrence: "<UID>@<occurrence start as Instant>";
   * profiles: profile_id; derived properties: "<parent record id>#address".
   */
  sourceRecordId: string
  /** Start of the ingest run (ctx.ingestedAt); identical for every record in a run. */
  ingestedAt: Instant
}

/** Stable cross-reference keys inside one ingest run. */
export type ProviderKey = string // `${sourceSystem}:${sourceAccount}`
export type PropertyKey = string // `${sourceSystem}:${sourceAccount}:${native property/address id or derived hash}`

export interface RawAddress {
  line1: string | null // "4512 Live Oak St"
  line2: string | null // "Apt 4", "#4", "Unit 4"
  city: string | null
  state: string | null
  zip: string | null // as given: "75204", "75204-3637", null
  /** Set when the source has only one free-text address field (CSV); line1..zip are then null. */
  freeText: string | null
}

/** Homeowner PII. Stored in a table the MCP reader role cannot read (R17). */
export interface ContactPii {
  sourceCustomerId: string | null
  name: string | null
  phones: string[]
  emails: string[]
}

export interface ProviderCandidate {
  type: 'provider'
  ref: SourceRef
  providerKey: ProviderKey
  businessName: string
  ownerName: string | null
  /** Business phones/emails/website: used for matching, not homeowner PII. */
  phones: string[]
  emails: string[]
  website: string | null
  /** Raw trade hints: profile trades, CRM industry, account name words. */
  tradesRaw: string[]
  doesNotDoRaw: string[]
  /** Declared service zips (profiles only); null when the source does not declare them. */
  declaredServiceZips: string[] | null
  crewSize: number | null
  /** CRM the profile says the provider uses (profiles only), as given. */
  declaredCrm: string | null
  baseAddress: RawAddress | null
}

export interface PropertyCandidate {
  type: 'property'
  ref: SourceRef
  propertyKey: PropertyKey
  providerKey: ProviderKey
  address: RawAddress
  contact: ContactPii | null
}

export type JobKind = 'job' | 'estimate' | 'visit'

export type JobStatus =
  | 'scheduled' // booked for a future slot
  | 'in_progress' // started, not finished
  | 'completed' // work done (includes "requires invoicing", "Done")
  | 'cancelled' // any cancellation, including no-shows
  | 'on_hold' // waiting for parts/client; has no reliable slot
  | 'unscheduled' // accepted but never given a slot
  | 'limbo' // contradictory or stale, e.g. scheduled in the past and never completed

/** How the source expressed the time; drives confidence and tests (R12). */
export type TimeBasis =
  | 'utc' // "…Z" in the source (CRM A)
  | 'explicit_zone' // ICS TZID or an offset in the source
  | 'local_assumed' // zone-less local time, interpreted as America/Chicago (CRM B, CRM C, CSV)
  | 'date_only' // a date without a time (CSV loose dates, ICS all-day)

export interface JobCandidate {
  type: 'job'
  ref: SourceRef
  kind: JobKind
  providerKey: ProviderKey
  propertyKey: PropertyKey | null
  /** For kind 'visit': the sourceRecordId of the parent CRM A job. */
  parentSourceRecordId: string | null
  statusRaw: string // e.g. "archived", "Canceled / No show", "scheduled"
  status: JobStatus
  startAt: Instant | null
  endAt: Instant | null // when a source gives only a start, null (never invented)
  allDay: boolean
  timeBasis: TimeBasis | null
  completedAt: Instant | null
  sourceCreatedAt: Instant | null
  sourceUpdatedAt: Instant | null
  /** Free text that names the work: title, description, JobType, CSV "Job" column. */
  tradeRaw: string | null
  descriptionRaw: string | null
  notesRaw: string | null // may contain PII; redacted before it leaves the server
  amountCents: number | null // integer cents, never floats
  amountRaw: string | null
  isRecurring: boolean
  /** Free-text evidence of a reschedule, e.g. "Rescheduled from 11/1". */
  rescheduleNote: string | null
  /** CRM B jobs: the native ID of the approved estimate the job was created from (G5). */
  originalEstimateRecordId?: string | null
}

export interface CalendarBlockCandidate {
  type: 'calendar_block'
  ref: SourceRef // one candidate per expanded occurrence
  providerKey: ProviderKey
  startAt: Instant
  endAt: Instant
  allDay: boolean
  timeBasis: TimeBasis
  /** false when TRANSP:TRANSPARENT or STATUS:CANCELLED. */
  busy: boolean
  category: 'work' | 'personal' | 'unknown'
  summaryRaw: string | null // server-only
  /** Master UID and RRULE when the block came from a recurring event. */
  recurrence: { masterUid: string; rrule: string } | null
}

export interface DeclaredHoursCandidate {
  type: 'declared_hours'
  ref: SourceRef
  providerKey: ProviderKey
  hoursRaw: string // "Mon-Fri 8am-5pm, Sat 9am-1pm"
  /** Parsed weekly windows in local time; weekday 1 = Monday … 7 = Sunday (ISO, luxon). */
  weekly: Array<{ weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7; start: string; end: string }> // "HH:mm"
  parsed: 'full' | 'partial' | 'none'
}

export type Candidate =
  | ProviderCandidate
  | PropertyCandidate
  | JobCandidate
  | CalendarBlockCandidate
  | DeclaredHoursCandidate

export interface IngestIssue {
  ref: SourceRef
  severity: 'info' | 'warn' | 'error'
  code: string // e.g. "csv.blank_date", "status.unmapped", "time.ambiguous_local"
  message: string // never includes PII values
}

export interface CandidateBatch {
  providers: ProviderCandidate[]
  properties: PropertyCandidate[]
  jobs: JobCandidate[]
  calendarBlocks: CalendarBlockCandidate[]
  declaredHours: DeclaredHoursCandidate[]
  issues: IngestIssue[]
}

export interface AdapterContext {
  dataPackDir: string
  ingestedAt: Instant
  today: LocalDate // default "2026-11-02"
  now: Instant // default "2026-11-02T06:00:00Z"
  timeZone: 'America/Chicago'
  /** ICS recurrence expansion window: [today - historyDays, today + horizonDays). */
  historyDays: number // default 731
  horizonDays: number // default 31
}

export interface SourceFile {
  path: string // relative to dataPackDir, "/" separators
  content: string
}

export interface SourceAdapter {
  readonly sourceSystem: SourceSystem
  /** Glob(s) relative to dataPackDir, e.g. ["sources/workiz/<account>/*.json"]. */
  readonly patterns: readonly string[]
  /** Pure: no disk, network, clock or database access. */
  parse(files: readonly SourceFile[], ctx: AdapterContext): CandidateBatch
}
