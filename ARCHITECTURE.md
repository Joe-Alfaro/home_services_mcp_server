# Architecture

Requirements and done checks: [`docs/requirements/home-services-mcp.md`](docs/requirements/home-services-mcp.md).
Requirement IDs (R1-R29, G1-G28) below refer to that file.

## Problem

A home-services marketplace needs one answer to homeowners' real questions: who near me has done
this kind of work, what is already scheduled on my street, and who can come this week. The answers
are scattered across six provider sources that disagree on shape, time zones, status vocabulary,
money units and address spelling: three field-service CRMs (Jobber-style nested JSON, Housecall
Pro-style paged REST, Workiz-style REST with status codes), a hand-kept CSV job log, ICS calendars
and self-declared provider profiles. The same provider and the same home appear in several sources
under different spellings. This system ingests each source through its own adapter, normalizes
everything into one canonical model with provenance and match confidence, computes availability
conservatively, and exposes the result to AI agents through a read-only, privacy-aware MCP server.

## Components and data flow

```text
DATA_PACK_DIR (default _private/data_pack in the repo root; never committed)
  │
  ▼
src/adapters/<source>.ts      one per source; pure parse(files, ctx) → CandidateBatch
  │  candidate records with SourceRef provenance; times as instants, status and money normalized
  │  using shared helpers; addresses and trades left raw
  ▼
src/normalize/                time · status · money · address · geocode (street_segments) · trade · redact
  │  NormalizedProperty (address key, block, zip, lat/lon), canonical trade, issues
  ▼
src/resolve/                  provider dedupe · property dedupe · job dedupe (CSV dup rows, cross-source)
  │  canonical entities + links { method, confidence, evidence }
  ▼
src/db/                       migrations, loader (one transaction per ingest run), read views, reader role
  │  Postgres (Docker, compose project hsmcp, host port 5434)
  ▼
src/availability/             declared hours − booked work − calendar blocks → openings with confidence
  │
  ▼
src/mcp/                      stdio MCP server; zod-validated tools; privacy projection; sources on every item
  │
  ▼
AI agent (any MCP client)     eval/ drives the same tools as a scripted MCP client
```

`npm run setup` runs: `docker compose -p hsmcp up -d --wait` → migrations → load street segments →
run every registered adapter → normalize → resolve → load in one transaction → print an ingest
summary (records, issues and unmapped values per source). Re-running replaces the previous ingest
run's data, so setup is idempotent (R22).

## Stack and why

| Choice                                                             | Why                                                                                                                                                                        |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript on Node 24 (strict)                                     | One language for adapters, server and tests; the contract below is checked by the compiler.                                                                                |
| Postgres 17 in local Docker (`docker-compose.yml`, host port 5434) | Real relational modeling, constraints, `timestamptz` instants, and a read-only role to enforce R16/R17 in the database rather than in code. Runs locally with one command. |
| `pg`                                                               | Plain SQL; migrations are numbered `.sql` files in `src/db/migrations/`. No ORM, so the schema in `docs/data-model.md` is the real schema.                                 |
| `@modelcontextprotocol/sdk` (stdio) + `zod`                        | Official SDK; zod schemas give tight parameters and precise error messages (R18).                                                                                          |
| `luxon`                                                            | IANA zone handling for America/Chicago, including the 2026-11-01 DST change (R12).                                                                                         |
| `node-ical`                                                        | Parses ICS including `TZID`, all-day `VALUE=DATE`, `RRULE`, `EXDATE`, `RECURRENCE-ID`.                                                                                     |
| `csv-parse`                                                        | Robust quoting for the free-text CSV job log.                                                                                                                              |
| Vitest; `testcontainers` for Postgres                              | Fast unit tests on fixtures; integration tests on a throwaway database (R23).                                                                                              |
| ESLint, Prettier, tsc, scrub check in `npm run check`              | One quality gate before every merge.                                                                                                                                       |

Deliberately not used: an ORM, PostGIS (half-mile radius over ~3,600 homes is a cheap haversine in
SQL or TypeScript), fuzzy-matching ML, any network service.

## Proposed layout

```text
src/
  config.ts                 HS_TODAY, HS_NOW, HS_TIMEZONE, DATA_PACK_DIR, DATABASE_URL, READER_DATABASE_URL
  adapters/
    types.ts                the adapter contract (below)
    registry.ts             the one list of adapters
    jobber.ts  housecallPro.ts  workiz.ts  spreadsheet.ts  ics.ts  profiles.ts
  normalize/
    time.ts  status.ts  money.ts  address.ts  geocode.ts  trade.ts  hours.ts  redact.ts  phone.ts  name.ts
  resolve/
    providers.ts  properties.ts  jobs.ts  confidence.ts
  db/
    migrations/0001_schema.sql …   pool.ts  load.ts  views.sql  roles.sql
  availability/
    engine.ts  inferredHours.ts  confidence.ts
  mcp/
    server.ts  privacy.ts  errors.ts
    tools/<toolName>.ts      one file per tool
  cli/
    setup.ts                 the one-command entry point
eval/
  questions.ts  expected/q1.json … q6.json  run.ts
test/
  fixtures/<source>/…        hand-made, invented names and addresses
  unit/…  integration/…
docs/
  requirements/home-services-mcp.md  data-model.md  decisions.md  ai-usage.md
```

## Adapter contract

Adapters are pure: `parse(files, ctx)` takes file contents and returns candidates, so tests feed
fixture strings with no disk or database. `listFiles(ctx)` is the only part that touches disk.
Adapters normalize what is source-specific (time basis, status vocabulary, money units, which
records are estimates or visits) by calling shared helpers in `src/normalize/`; they leave
addresses and trades as raw text for the shared normalizers.

```ts
// src/adapters/types.ts

export type SourceSystem =
  | 'jobber' // CRM A
  | 'housecall_pro' // CRM B
  | 'workiz' // CRM C
  | 'spreadsheet' // CSV job log
  | 'ics' // calendars
  | 'profiles'; // provider profiles

/** ISO-8601 instant in UTC, always with a trailing "Z", e.g. "2026-11-02T15:00:00Z". */
export type Instant = string;
/** Local calendar date "YYYY-MM-DD" in America/Chicago. */
export type LocalDate = string;

/** Provenance carried by every candidate (R11, R19). */
export interface SourceRef {
  sourceSystem: SourceSystem;
  /** Account folder or file stem, e.g. "lone_star_plumbing", "rays_fixit_job_log". */
  sourceAccount: string;
  /** Path relative to DATA_PACK_DIR with "/" separators, e.g. "sources/workiz/lone_star_plumbing/jobs.json". */
  sourceFile: string;
  /**
   * Native record ID. Conventions where none exists:
   * CSV: "row:<1-based physical line number>";
   * ICS occurrence: "<UID>@<occurrence start as Instant>";
   * profiles: profile_id; derived properties: "<parent record id>#address".
   */
  sourceRecordId: string;
  /** Start of the ingest run (ctx.ingestedAt); identical for every record in a run. */
  ingestedAt: Instant;
}

/** Stable cross-reference keys inside one ingest run. */
export type ProviderKey = string; // `${sourceSystem}:${sourceAccount}`
export type PropertyKey = string; // `${sourceSystem}:${sourceAccount}:${native property/address id or derived hash}`

export interface RawAddress {
  line1: string | null; // "4512 Live Oak St"
  line2: string | null; // "Apt 4", "#4", "Unit 4"
  city: string | null;
  state: string | null;
  zip: string | null; // as given: "75204", "75204-3637", null
  /** Set when the source has only one free-text address field (CSV); line1..zip are then null. */
  freeText: string | null;
}

/** Homeowner PII. Stored in a table the MCP reader role cannot read (R17). */
export interface ContactPii {
  sourceCustomerId: string | null;
  name: string | null;
  phones: string[];
  emails: string[];
}

export interface ProviderCandidate {
  type: 'provider';
  ref: SourceRef;
  providerKey: ProviderKey;
  businessName: string;
  ownerName: string | null;
  /** Business phones/emails/website: used for matching, not homeowner PII. */
  phones: string[];
  emails: string[];
  website: string | null;
  /** Raw trade hints: profile trades, CRM industry, account name words. */
  tradesRaw: string[];
  doesNotDoRaw: string[];
  /** Declared service zips (profiles only); null when the source does not declare them. */
  declaredServiceZips: string[] | null;
  crewSize: number | null;
  /** CRM the profile says the provider uses (profiles only), as given. */
  declaredCrm: string | null;
  baseAddress: RawAddress | null;
}

export interface PropertyCandidate {
  type: 'property';
  ref: SourceRef;
  propertyKey: PropertyKey;
  providerKey: ProviderKey;
  address: RawAddress;
  contact: ContactPii | null;
}

export type JobKind = 'job' | 'estimate' | 'visit';

export type JobStatus =
  | 'scheduled' // booked for a future slot
  | 'in_progress' // started, not finished
  | 'completed' // work done (includes "requires invoicing", "Done")
  | 'cancelled' // any cancellation, including no-shows
  | 'on_hold' // waiting for parts/client; has no reliable slot
  | 'unscheduled' // accepted but never given a slot
  | 'limbo'; // contradictory or stale, e.g. scheduled in the past and never completed

/** How the source expressed the time; drives confidence and tests (R12). */
export type TimeBasis =
  | 'utc' // "…Z" in the source (CRM A)
  | 'explicit_zone' // ICS TZID or an offset in the source
  | 'local_assumed' // zone-less local time, interpreted as America/Chicago (CRM B, CRM C, CSV)
  | 'date_only'; // a date without a time (CSV loose dates, ICS all-day)

export interface JobCandidate {
  type: 'job';
  ref: SourceRef;
  kind: JobKind;
  providerKey: ProviderKey;
  propertyKey: PropertyKey | null;
  /** For kind 'visit': the sourceRecordId of the parent CRM A job. */
  parentSourceRecordId: string | null;
  statusRaw: string; // e.g. "archived", "Canceled / No show", "scheduled"
  status: JobStatus;
  startAt: Instant | null;
  endAt: Instant | null; // when a source gives only a start, null (never invented)
  allDay: boolean;
  timeBasis: TimeBasis | null;
  completedAt: Instant | null;
  sourceCreatedAt: Instant | null;
  sourceUpdatedAt: Instant | null;
  /** Free text that names the work: title, description, JobType, CSV "Job" column. */
  tradeRaw: string | null;
  descriptionRaw: string | null;
  notesRaw: string | null; // may contain PII; redacted before it leaves the server
  amountCents: number | null; // integer cents, never floats
  amountRaw: string | null;
  isRecurring: boolean;
  /** Free-text evidence of a reschedule, e.g. "Rescheduled from 11/1". */
  rescheduleNote: string | null;
}

export interface CalendarBlockCandidate {
  type: 'calendar_block';
  ref: SourceRef; // one candidate per expanded occurrence
  providerKey: ProviderKey;
  startAt: Instant;
  endAt: Instant;
  allDay: boolean;
  timeBasis: TimeBasis;
  /** false when TRANSP:TRANSPARENT or STATUS:CANCELLED. */
  busy: boolean;
  category: 'work' | 'personal' | 'unknown';
  summaryRaw: string | null; // server-only
  /** Master UID and RRULE when the block came from a recurring event. */
  recurrence: { masterUid: string; rrule: string } | null;
}

export interface DeclaredHoursCandidate {
  type: 'declared_hours';
  ref: SourceRef;
  providerKey: ProviderKey;
  hoursRaw: string; // "Mon-Fri 8am-5pm, Sat 9am-1pm"
  /** Parsed weekly windows in local time; weekday 1 = Monday … 7 = Sunday (ISO, luxon). */
  weekly: Array<{ weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7; start: string; end: string }>; // "HH:mm"
  parsed: 'full' | 'partial' | 'none';
}

export type Candidate =
  | ProviderCandidate
  | PropertyCandidate
  | JobCandidate
  | CalendarBlockCandidate
  | DeclaredHoursCandidate;

export interface IngestIssue {
  ref: SourceRef;
  severity: 'info' | 'warn' | 'error';
  code: string; // e.g. "csv.blank_date", "status.unmapped", "time.ambiguous_local"
  message: string; // never includes PII values
}

export interface CandidateBatch {
  providers: ProviderCandidate[];
  properties: PropertyCandidate[];
  jobs: JobCandidate[];
  calendarBlocks: CalendarBlockCandidate[];
  declaredHours: DeclaredHoursCandidate[];
  issues: IngestIssue[];
}

export interface AdapterContext {
  dataPackDir: string;
  ingestedAt: Instant;
  today: LocalDate; // default "2026-11-02"
  now: Instant; // default "2026-11-02T06:00:00Z"
  timeZone: 'America/Chicago';
  /** ICS recurrence expansion window: [today - historyDays, today + horizonDays). */
  historyDays: number; // default 731
  horizonDays: number; // default 31
}

export interface SourceFile {
  path: string; // relative to dataPackDir, "/" separators
  content: string;
}

export interface SourceAdapter {
  readonly sourceSystem: SourceSystem;
  /** Glob(s) relative to dataPackDir, e.g. ["sources/workiz/*/*.json"]. */
  readonly patterns: readonly string[];
  /** Pure: no disk, network, clock or database access. */
  parse(files: readonly SourceFile[], ctx: AdapterContext): CandidateBatch;
}
```

Per-source rules every adapter test checks:

| Source        | Provider                                   | Properties                                   | Jobs                                                                                                                                                                                           | Other                                                                                    |
| ------------- | ------------------------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| jobber        | one per file from `account`                | one per client property; contact from client | one `job` per job with no visits; one `visit` per visit, with `parentSourceRecordId`; status from `visitStatus` for visits, `jobStatus` otherwise; `timeBasis: 'utc'`; `total` dollars → cents | `recurrence` → `isRecurring`                                                             |
| housecall_pro | one per company folder from `company.json` | one per customer address                     | jobs → `kind: 'job'`; estimates → `kind: 'estimate'`; zone-less `schedule` → `local_assumed`; amounts already cents                                                                            | all `*_page_N.json` pages read                                                           |
| workiz        | one per account folder from `account.json` | one per distinct (ClientId, address) in jobs | `Status` + `SubStatus` → status; `JobType` → `tradeRaw`; zone-less times → `local_assumed`; `"$1460"` → cents                                                                                  |                                                                                          |
| spreadsheet   | one per file from the title row            | one per distinct free-text address           | one `job` per data row (duplicates kept; resolve collapses them); date-only rows → `date_only`, `allDay`                                                                                       | preamble rows before the header skipped                                                  |
| ics           | one per calendar from `X-WR-CALNAME`       | none                                         | none                                                                                                                                                                                           | one `calendar_block` per occurrence in the window; `VTIMEZONE` blocks ignored for events |
| profiles      | one per profile                            | none                                         | none                                                                                                                                                                                           | one `declared_hours` per profile                                                         |

Default status mapping, covering every raw value present in the data pack (adapters own the
table; the gotcha pass may refine it). CRM A visits use `visitStatus`; CRM A jobs without visits
use `jobStatus`. Workiz values are `Status / SubStatus`.

| Canonical   | jobber                                                              | housecall_pro (jobs and estimates)   | workiz                                                            |
| ----------- | ------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------- |
| completed   | visit `COMPLETED`; job `archived`, `requires_invoicing`             | `complete rated`, `complete unrated` | `Done`, `Done Pending Approval`                                   |
| scheduled   | visit `UPCOMING`, `TODAY`; job `upcoming`, `today`                  | `scheduled`                          | `Pending / Scheduled`, `Submitted` (with a slot)                  |
| in_progress | job `active` without visits                                         | —                                    | —                                                                 |
| cancelled   | visit `CANCELLED`                                                   | `pro canceled`, `user canceled`      | `Canceled` (any sub-status, incl. `No show`, `Customer canceled`) |
| on_hold     | job `action_required`                                               | —                                    | `Pending / On Hold`, `Waiting for parts`, `Waiting for client`    |
| unscheduled | visit `UNSCHEDULED`; job `unscheduled`                              | `needs scheduling`                   | `Submitted` (no slot)                                             |
| limbo       | visit `OVERDUE`; any `scheduled`/`in_progress` item whose end < now | same rule                            | same rule                                                         |

A completed estimate (`complete rated` on an estimate) means the estimate visit happened, not the
work: it stays `kind: 'estimate'` and never counts as completed work.

Unknown raw values map to `limbo` and raise a `status.unmapped` issue, so setup reports them (R9).

## Canonical Postgres schema

All times are `timestamptz`. Every canonical row traces to `source_records` (R11).

```text
ingest_runs        id, started_at, today, now, data_pack_dir, summary jsonb
source_records     id, run_id → ingest_runs, source_system, source_account, source_file,
                   source_record_id, record_type, ingested_at
                   UNIQUE (run_id, source_system, source_file, source_record_id)
street_segments    street_name, street_type, city, state, zip, from_number, to_number,
                   start_lat, start_lon, end_lat, end_lon

providers          id, display_name, trades text[], declared_service_zips text[],
                   observed_service_zips text[], crew_size, business_phone, website
provider_links     provider_id → providers, source_record_id → source_records,
                   method, confidence numeric(3,2), evidence jsonb
provider_conflicts provider_id, kind ('hours'|'service_area'|'trade'|'crm'), detail, source_record_ids bigint[]

properties         id, address_key UNIQUE, house_number, street_name, street_type, unit,
                   zip, zip_inferred bool, city, block_label ("4500 block of Live Oak St"),
                   lat, lon, geocode_method ('interpolated'|'none'), in_target_zip bool
property_links     property_id, source_record_id, raw_address_hash, method, confidence, evidence
homeowner_contacts property_id, source_record_id, name, phones text[], emails text[]   -- PII, no reader grant

jobs               id, provider_id, property_id NULL, parent_job_id NULL → jobs, kind,
                   status, status_raw, trade, service, start_at, end_at, all_day,
                   time_basis, completed_at, amount_cents bigint, is_recurring,
                   description_redacted, duplicate_count
job_links          job_id, source_record_id, method, confidence, evidence

declared_hours     provider_id, weekday smallint, start_local time, end_local time, source_record_id, parsed
calendar_blocks    id, provider_id, start_at, end_at, all_day, busy, category, recurrence_uid, source_record_id

match_decisions    entity ('provider'|'property'|'job'), left_ref, right_ref, method, score, decision, evidence
```

Read views (`v_providers`, `v_properties`, `v_jobs`, `v_calendar_blocks`, `v_declared_hours`,
`v_sources`) expose everything except PII; the `hsmcp_reader` role has `SELECT` on the views only.
The MCP server connects as that role (R16, R17).

### Resolution methods (R6-R8)

- **Providers:** normalize business name (lowercase, strip punctuation and `llc|inc|co|company|the`),
  phone digits, email domain and website host. Same phone digits → 0.95; same email domain or
  website → 0.9; same normalized name plus compatible trade → 0.8; name similarity alone never
  merges (it is recorded in `match_decisions` as a rejected candidate). Profiles link to CRM
  providers by the same rules.
- **Properties:** address key = house number + normalized street name + street type (USPS
  abbreviations) + unit (`apt|unit|#|ste` → `#n`) + 5-digit zip. Exact key → 1.0; key with zip
  inferred from street segments → 0.85; free-text CSV address parsed into the key → 0.8. Unit
  mismatches never merge.
- **Jobs:** CSV rows identical after normalization (date, time, address key, job text, amount) →
  one job with `duplicate_count`, confidence 0.95. Same provider + property + start within 30 min
  across sources → merged at 0.8. CRM A visits stay separate rows linked by `parent_job_id`.

## Availability engine (R13)

For a provider and a window `[from, to)` (never before `now`):

1. **Base:** declared weekly hours from the profile, materialized per local date with luxon (so
   DST days are correct). If none or unparseable, infer hours from the provider's observed work
   (earliest start, latest end per weekday over the last 90 days) and mark `low` confidence.
2. **Subtract** every interval that any source says is busy: CRM jobs, visits and estimates with
   any status other than `cancelled` or `completed` that has a slot in the window (`scheduled`,
   `in_progress`, `on_hold`, `limbo`; the cautious answer wins), and ICS blocks with `busy = true`
   (work or personal, all-day and recurring occurrences included). Cancelled items and items with
   no slot do not subtract. Jobs without an end get a trade-default
   duration and a reason.
3. **Keep** gaps ≥ the requested minimum duration.
4. **Confidence:** start `high`; drop to `medium` for: work observed outside declared hours,
   provider found in several sources with partial coverage, limbo items that day, crew size > 1
   treated as one schedule; drop to `low` for inferred hours or no recent data. Each drop adds a
   reason string with the source that caused it.

Crew size is reported but not used to run parallel schedules; the cautious answer wins.

## MCP tools (R15-R21)

| Tool                              | Answers | Key parameters                                                                      |
| --------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `search_job_history_near_address` | Q1      | `address`, `radiusMiles` (≤ 5), `since`/`until` or `lastMonths`, `groupBy: 'trade'` |
| `find_providers`                  | Q2, Q6  | `trade` (enum), `workedInZip`, `nearZip`, `minOpeningMinutes`, `window`             |
| `get_scheduled_work_on_block`     | Q3      | `street`, `blockNumber` (e.g. 4500), `zip?`, `nextDays` (≤ 30)                      |
| `get_provider_profile`            | Q4      | `providerName` or `providerId`, `openingsLimit`                                     |
| `get_property_service_history`    | Q5      | `address`                                                                           |
| `rank_providers_for_job`          | Q6      | `trade`, `service` (free text, mapped), `nearZip`, `window: 'this_week'\|…`         |
| `get_provider_openings`           | Q2, Q4  | `providerId`, `from`, `to`, `minMinutes`, `limit`                                   |

Every response item carries `sources` and, where merged, `confidence`. Properties are projected to
`{ block, zip }`; a house number is included only when it equals the one in the request (R17).

## Requirement-to-component map

| Requirements       | Component                                                                               |
| ------------------ | --------------------------------------------------------------------------------------- |
| R1, R2, R3, R4     | `src/adapters/*`, `src/adapters/registry.ts`, `src/cli/setup.ts`                        |
| R5, R11            | `src/db/migrations`, `src/db/load.ts`                                                   |
| R6, R7, R8         | `src/normalize/address.ts`, `geocode.ts`, `name.ts`, `phone.ts`; `src/resolve/*`        |
| R9                 | `src/normalize/status.ts`, per-adapter mapping tables                                   |
| R10                | Gotchas section of the requirements; `docs/data-model.md`                               |
| R12, R14           | `src/normalize/time.ts`, `src/config.ts`                                                |
| R13                | `src/availability/*`, `src/normalize/hours.ts`                                          |
| R15, R18, R19, R21 | `src/mcp/server.ts`, `src/mcp/tools/*`, `src/mcp/errors.ts`                             |
| R16, R17           | `src/db/roles.sql`, `src/db/views.sql`, `src/mcp/privacy.ts`, `src/normalize/redact.ts` |
| R20, R29           | `eval/`                                                                                 |
| R22                | `docker-compose.yml`, `src/cli/setup.ts`, `package.json`                                |
| R23                | `test/unit`, `test/integration`, `test/fixtures`                                        |
| R24-R28            | `docs/`, `README.md`                                                                    |

## How the traps are handled

Each confirmed trap is a G-ID in the requirements Gotchas section, with its done check. Components
are paths under `src/` from the layout above.

| G-ID | Trap                                                        | Component                                                                       | Handling                                                                                                       |
| ---- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| G1   | UTC vs zone-less local times vs mixed ICS zones             | `normalize/time.ts`; every adapter sets `TimeBasis`                             | luxon in America/Chicago, DST-aware; no host-zone dependence (R12).                                            |
| G2   | Zone-less time in the repeated hour on 2026-11-01           | `normalize/time.ts`                                                             | Ambiguous local times take the earlier (CDT) instant; nonexistent times shift forward (R12).                   |
| G3   | CRM B job repeated across a page boundary                   | `adapters/housecallPro.ts`                                                      | Pages read in numeric order; repeated IDs dropped with a warning issue (R1).                                   |
| G4   | Estimates mixed with jobs; scheduled estimates take time    | `adapters/housecallPro.ts`, `adapters/spreadsheet.ts`; `availability/engine.ts` | `kind: 'estimate'`; never counted as work; scheduled estimates block time (R4, R13).                           |
| G5   | Approved estimate and its job double-count                  | `resolve/jobs.ts`                                                               | Job linked to its estimate via `original_estimate_id`; one service in history (R8).                            |
| G6   | One job, many visits; recurring jobs                        | `adapters/jobber.ts`; `availability/engine.ts`                                  | Visit rows under a parent; only listed visits, rules never expanded; per-visit status and money (R4).          |
| G7   | Cents vs dollar strings vs `$1,234.50`                      | `normalize/money.ts`                                                            | Everything becomes integer `amount_cents` or `null` (R4).                                                      |
| G8   | Status vocabularies, cancelled spellings, limbo             | `normalize/status.ts`, per-adapter mapping tables                               | One canonical set; CSV notes and ICS `CXL` read for cancellation; stale non-terminal → `limbo` (R9).           |
| G9   | "Rescheduled" only in notes                                 | `normalize/status.ts`                                                           | `rescheduled_from` flag parsed from notes; no extra job, old slot never blocks (R9).                           |
| G10  | Completed job dated in the future                           | `normalize/status.ts`; `availability/engine.ts`                                 | `suspect_date` issue; kept in history, not a booking (R9, R13).                                                |
| G11  | Multi-day spans                                             | `availability/engine.ts`                                                        | Clipped to declared hours per day with a `multi_day_span` reason; no hours conflict (R13).                     |
| G12  | Undated work                                                | every adapter; `availability/engine.ts`                                         | Null times, status `unscheduled`, no block; missing end → trade-default duration with a reason (R9, R13).      |
| G13  | Lone Star Plumbing across two CRMs; "Lone Star" name prefix | `resolve/providers.ts`, `normalize/phone.ts`, `normalize/name.ts`               | Merge on phone digits, email domain, website; names alone never merge (R6, R8).                                |
| G14  | Rebranded provider with two accounts                        | `resolve/providers.ts`                                                          | Phone match merges; both names kept as aliases (R6).                                                           |
| G15  | Technician names shared across businesses                   | `resolve/providers.ts`                                                          | Employee names are never a match key (R6).                                                                     |
| G16  | Messy CSV log                                               | `adapters/spreadsheet.ts`; `resolve/jobs.ts`                                    | Preamble skipped; dates resolved against the export date; duplicates collapsed with `duplicate_count` (R4).    |
| G17  | ICS all-day, RRULE, transparent/tentative, mirrored jobs    | `adapters/ics.ts`; `resolve/jobs.ts`                                            | Exclusive all-day end; RRULE expanded in local time inside the window; mirrored CRM jobs merged (R4, R13).     |
| G18  | CSV and calendar disagree for one provider                  | `resolve/jobs.ts`; `availability/confidence.ts`                                 | Same provider and start within 30 min merge; disagreements and single-source items lower confidence (R8, R13). |
| G19  | Address variants and typos                                  | `normalize/address.ts`, `normalize/geocode.ts`; `resolve/properties.ts`         | Address key normalization; fuzzy street match against the reference with lowered confidence (R7).              |
| G20  | Free-form profile hours, CRM names, phones                  | `normalize/hours.ts`, `normalize/phone.ts`, `adapters/profiles.ts`              | Hours parsed to a weekly schedule or flagged unknown; phones to 10 digits (R6, R13).                           |
| G21  | Free-text job types and trade mapping                       | `normalize/trade.ts`                                                            | Provider trade first, refined by a curated phrase map with water-heater subtypes (R4, R21).                    |
| G22  | Geocoding coverage and ambiguous streets                    | `normalize/geocode.ts`                                                          | Interpolation on street segments; otherwise `geocode_method = 'none'` with a reason (R3, R7).                  |
| G23  | Profile vs observed trades, zips, hours, crew               | `resolve/providers.ts`; `availability/confidence.ts`                            | `provider_conflicts` rows; declared and observed shown side by side; crew treated as one schedule (R13).       |
| G24  | Same home under many spellings; units                       | `resolve/properties.ts`                                                         | Units are separate homes; out-of-area keys include the zip (R7).                                               |
| G25  | Snapshot and window edges                                   | `config.ts`; `availability/engine.ts`; `mcp/tools/*`                            | Windows on local midnights from configured "today", never the clock (R14).                                     |
| G26  | History before the window or out of area                    | `mcp/tools/*`; `normalize/geocode.ts`                                           | Window filter on local time; out-of-area records kept but never placed in a radius (R7, R12).                  |
| G27  | PII in ICS summaries, calendar names, CSV and CRM rows      | `adapters/ics.ts`, `normalize/redact.ts`, `mcp/privacy.ts`; `db/roles.sql`      | Names to `homeowner_contacts` only; free text redacted; reader role denied (R17).                              |
| G28  | Same house number on another street                         | `normalize/address.ts`; `resolve/properties.ts`                                 | Matching requires the street, not number plus zip; fuzzy threshold rejects unrelated streets (R7).             |

## Test strategy

- **Unit (Vitest, `npm test`):** every adapter on hand-made fixtures in `test/fixtures/<source>/`
  that mimic the real shape with invented data; every normalizer (time incl. DST edges, status,
  money, address, geocode, trade, hours, redact); every resolver tier; the availability engine on
  synthetic schedules. No database, no clock (inject `ctx.now`).
- **Integration (`npm run test:integration`):** Postgres from testcontainers (or a separate database
  on the compose server), never the dev database. Covers migrations, load idempotency, provenance
  joins, the reader role's write failure and PII denial, and each MCP tool through an in-process
  MCP client.
- **Eval harness (`npm run eval`):** an MCP client over stdio runs Q1-Q6 against the real ingested
  pack and compares with `eval/expected/`, which is derived from the raw pack by a separate pass
  that does not read the implementation. Reports the pass rate (R29).
- **Gate:** `npm run check` = Prettier check, ESLint, `tsc --noEmit`, unit tests, scrub check.

## Risks

| Risk                                          | Mitigation                                                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Time-zone and DST errors silently break Q2-Q4 | `TimeBasis` on every record; DST-edge unit tests written first.                                          |
| Over- or under-merging providers and homes    | Conservative thresholds; rejected candidates logged in `match_decisions`; confidence shown to the agent. |
| Unlisted traps missed                         | Dedicated source-profiling pass; unmapped-value counts in the setup summary.                             |
| PII leaks through free text                   | Database role denial plus redaction plus a leak test that scans every tool response.                     |
| Agent picks the wrong tool                    | One tool per question shape, "use this when / not when" descriptions, eval checks the tool used.         |
| Expected answers that only mirror the code    | Expected answers derived independently from the raw pack.                                                |
| Tight schedule                                | Small tool set, deterministic rules, no ML; cut list in `docs/decisions.md`.                             |
