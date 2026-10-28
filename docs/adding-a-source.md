# Adding a data source

How to add a seventh source (another CRM, job log, calendar or profile feed) through the adapter
contract. A source is one adapter module, one registry line, one name and one traits entry. No core
module (`src/normalize/`, `src/resolve/`, `src/ingest/`, `src/availability/`, `src/db/`,
`src/mcp/`) changes, and no migration is needed: `source_records`, `ingest_issues` and the views
store `source_system` as plain text.

This path has not yet been exercised with a real new source (see R30 in
[`decisions.md`](decisions.md#what-was-cut)). If a step below turns out wrong, fix this guide in
the same change.

The examples use a made-up source called `acme_crm`. Replace it with your source's name in
`snake_case`.

## Scaffold it

`npm run new-source` does steps 1 to 5 below as a stub you then fill in:

```sh
npm run new-source -- acme_crm --role crm --format json --crm-pattern 'acme' --dry-run  # the plan
npm run new-source -- acme_crm --role crm --format json --crm-pattern 'acme'
```

- `<name>` (required): the `snake_case` name, also the folder under `data/sources/`. It must match
  `^[a-z][a-z0-9]*(_[a-z0-9]+)*$` and must not be a registered source.
- `--role` (required): `crm`, `log`, `calendar`, `profile` or `other`; see step 2.
- `--format`: `json` (default), `csv` or `ics`. It picks the fixture and the reader the stub starts
  from.
- `--crm-pattern <regex>`: `crm` only. The `declaredCrmPattern`, always case-insensitive. Without
  it, the name with any separator (`/acme[ _-]?crm/i` for `acme_crm`). Other roles get `null`.
- `--dry-run`: print the files it would create or edit and the traits entry, and write nothing.
- `--skip-checks`: skip the type check and adapter tests it runs at the end.

What it does:

- Adds `'acme_crm'` to the end of the `SourceSystem` union, an entry at the end of
  `SOURCE_TRAITS`, and `acmeCrmAdapter` (import and list entry) to the registry. These edits are
  located through the TypeScript syntax tree (ts-morph) and only add lines.
- Creates `src/adapters/acmeCrm.ts`: `patterns: ['sources/acme_crm/*/*.json']`, a `parse` that
  reads each file through the `shared.ts` helpers (an `error` issue for an unreadable file) and
  maps nothing yet, a TODO `mapRecord` stub that reports each record with an
  `acme_crm.not_mapped` info issue, and the invariants below as comments.
- Creates an invented fixture, `test/fixtures/acme_crm/sample_account/records.json` (`.csv` or
  `.ics` for those formats).
- Creates `test/unit/adapters/acmeCrm.test.ts`: passing contract checks (patterns, claimed
  fixtures, empty batch for no files, no error issues, purity, no fixture PII in issue messages)
  and one `it.fails('map your first record', ...)` that expects the first candidate of the role's
  kind (a job for `crm` and `log`, a calendar block for `calendar`, a provider for `profile`, any
  candidate for `other`).
- Runs `npm run typecheck` and the new test with the registry contract test, then prints the next
  steps and the [agent prompt](#prompt-for-a-coding-agent) with the names filled in. A run takes
  a few seconds.

It is safe to re-run: it refuses (nonzero exit, nothing written) an invalid or registered name, an
unknown role or format, and any target file or fixture folder that already exists. It never edits
an existing test, so `npm test` stays red until you update `registry.test.ts` (step 5).

Then: update `registry.test.ts`, put the real files in `data/sources/acme_crm/`, adjust the
pattern and fixtures to the real layout, write the mapping (the TODOs), drop the `.fails` marker on
`map your first record`, and add tests per mapping. The steps below explain each piece.

## Steps

### 1. Name the source

In [`src/adapters/types.ts`](../src/adapters/types.ts), add the name to the `SourceSystem` union:

```ts
export type SourceSystem =
  | 'jobber' // CRM A
  // ...
  | 'profiles' // provider profiles
  | 'acme_crm' // CRM D
```

### 2. Declare its role

In the same file, add an entry to `SOURCE_TRAITS`. It is typed
`Record<SourceSystem, SourceTraits>`, so `npm run typecheck` fails until you do. Core code reads
these roles and never a source-system name.

```ts
acme_crm: { role: 'crm', declaredCrmPattern: /acme/i },
```

| `role`     | Meaning                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------ |
| `crm`      | A field-service CRM. Its bookings are confirmed on their own.                                                      |
| `log`      | A hand-kept job log. Identical rows are one job, and a booking only a log records is unconfirmed (low confidence). |
| `calendar` | A calendar export, named after its owner rather than the business.                                                 |
| `profile`  | The provider's own profile. Its names, trades and declared facts lead.                                             |
| `other`    | No special role.                                                                                                   |

`declaredCrmPattern` is for `crm` sources only: a regular expression that matches a profile's
free-text "CRM we use" value naming this system (for example `/workiz/i`). Use `null` otherwise.
Entry order matters: declared CRMs are reported in this order, so add new entries at the end.

### 3. Write the adapter

Create `src/adapters/acmeCrm.ts` exporting a `SourceAdapter`. Module and test files use the
camelCase name (`housecallPro.ts` for `housecall_pro`); a one-word name such as `workiz` is used
as is.

```ts
import { mergeBatches, sortByPath } from './shared.ts'
import type { AdapterContext, CandidateBatch, SourceAdapter, SourceFile } from './types.ts'

function parseFile(file: SourceFile, ctx: AdapterContext): CandidateBatch {
  // ...
}

/** CRM D: one folder per account, jobs.json and account.json in each. */
export const acmeCrmAdapter: SourceAdapter = {
  sourceSystem: 'acme_crm',
  patterns: ['sources/acme_crm/*/*.json'],
  parse(files, ctx) {
    return mergeBatches(sortByPath(files).map((file) => parseFile(file, ctx)))
  },
}
```

- `sourceSystem` is the name from step 1.
- `patterns` are globs relative to `DATA_PACK_DIR` and must start with `sources/`. A `*` matches
  any run of characters within one path segment (`src/ingest/files.ts`). The adapter does not
  list files itself: the pipeline lists everything under `sources/`, gives each adapter the files
  its patterns claim, and reports any file no adapter claims as `unclaimed files` in the summary.
- `parse(files, ctx)` turns the claimed files into a `CandidateBatch`: `providers`, `properties`,
  `jobs`, `calendarBlocks`, `declaredHours` and `issues`. With no files it returns
  `emptyBatch()`.
- The data-pack folder is usually the system name (`sources/workiz/`), but need not be: the `ics`
  adapter reads `sources/calendars/`.

Build on the helpers in [`src/adapters/shared.ts`](../src/adapters/shared.ts) rather than writing
your own: `refFactory`, `makeIssue`, `parseJsonFile`, `textAt`/`numberAt`/`arrayAt`/`objectAt`,
`statusTable`/`mapStatus`, `localTime`, `finishJob`, `rescheduleNoteOf`, `accountFolder`,
`fileStem` and `mergeBatches`. Good models:
[`profiles.ts`](../src/adapters/profiles.ts) (small, one file, providers and declared hours) and
[`workiz.ts`](../src/adapters/workiz.ts) (a CRM: providers, properties with contact PII, jobs,
statuses and zone-less local times).

### 4. Register it

Add the adapter to the one list in
[`src/adapters/registry.ts`](../src/adapters/registry.ts):

```ts
import { acmeCrmAdapter } from './acmeCrm.ts'

export const adapters: readonly SourceAdapter[] = [
  // ...the existing six
  acmeCrmAdapter,
]
```

### 5. Add invented fixtures and tests

- Fixtures go under `test/fixtures/acme_crm/` (named after the data-pack folder), laid out as they
  are in the data pack below `sources/acme_crm/` (for example `test/fixtures/acme_crm/sample_account/jobs.json`).
  `loadFixtureFiles('acme_crm')` from
  [`test/unit/adapters/support.ts`](../test/unit/adapters/support.ts) reads them back as
  `SourceFile`s with data-pack paths such as `sources/acme_crm/sample_account/jobs.json`.
- Fixtures are small and hand-made: invented names, `555-01xx` phones, `example.com` emails and
  made-up addresses that mimic the source's shape and quirks. Never copy rows from the data pack.
- Tests go in `test/unit/adapters/acmeCrm.test.ts`, modelled on
  [`workiz.test.ts`](../test/unit/adapters/workiz.test.ts) or
  [`profiles.test.ts`](../test/unit/adapters/profiles.test.ts). Use the support helpers:
  `makeCtx`, `expectProvenance`, `expectUniqueRecordIds`, `expectAllInstantsUtc`,
  `expectInstant`, `expectIssuesFreeOf`, `issuesFor` and `one`. Cover at least: the pattern, purity
  (same input, same output), provenance, each status mapping, a zone-less time on both sides of the
  DST change, a missing end time, and that issue messages carry no PII.
- [`test/unit/adapters/registry-contract.test.ts`](../test/unit/adapters/registry-contract.test.ts)
  iterates the registry, so it checks the new adapter with no edits: exactly one registered
  adapter per `SourceSystem` member (read from the `SOURCE_TRAITS` keys), a `SOURCE_TRAITS` entry
  for each, and an empty, contract-shaped batch (only `info` issues) for no files.
- [`test/unit/adapters/registry.test.ts`](../test/unit/adapters/registry.test.ts) still pins the
  list of systems by hand. Add `'acme_crm'` to `ALL_SYSTEMS`, change `toHaveLength(6)` to `7`, and
  add `acmeCrmAdapter` to the `arrayContaining` list. Its per-system checks (patterns under
  `sources/`, an empty batch for no files) then cover the new adapter. This is the only existing
  test you edit.
- [`test/unit/architecture/r2-no-source-branching.test.ts`](../test/unit/architecture/r2-no-source-branching.test.ts)
  reads the systems from the registry, so it checks the new name automatically: core code must not
  compare against `'acme_crm'` anywhere.

### 6. Put the real files in place

Copy the real export into `data/sources/acme_crm/` (or under `$DATA_PACK_DIR/sources/acme_crm/`).
`data/` is git-ignored: real files are never committed.

## Invariants every adapter keeps

- **Pure.** `parse` reads only its arguments. No disk, database, network or clock: "today" and
  "now" come from `ctx.today` and `ctx.now`, and `ctx.ingestedAt` is the run timestamp. The same
  input gives the same output.
- **Instants are UTC with a trailing `Z`**, for example `2026-11-02T15:00:00Z` (the `Instant`
  type). Use `isoToInstant` for source times that carry `Z` or an offset, and `localTime` (which
  wraps `localToInstant`) for zone-less ones. `LocalDate` values are `YYYY-MM-DD` in
  America/Chicago.
- **`TimeBasis` says how the source expressed the time:** `utc` for `…Z`, `explicit_zone` for a
  TZID or offset, `local_assumed` for a zone-less wall-clock time read as America/Chicago, and
  `date_only` for a date without a time. Zone-less times are DST-aware: the repeated hour on the
  fall-back night (2026-11-01, 01:00-01:59) resolves to the earlier, daylight instant and
  `localTime` raises a `time.ambiguous_local` info issue. Never add a fixed offset by hand.
- **Provenance on every candidate.** Build each `SourceRef` with
  `refFactory(sourceSystem, sourceAccount, sourceFile, ctx)`. `sourceAccount` is the account folder
  or file stem; `sourceFile` is the path relative to `DATA_PACK_DIR` with `/` separators;
  `ingestedAt` is `ctx.ingestedAt`. `sourceRecordId` is the native record ID. Where none exists,
  follow the conventions in the `SourceRef` comment: CSV `row:<1-based physical line number>`, ICS
  occurrence `<UID>@<occurrence start as Instant>`, profiles `profile_id`, and a property derived
  from a job `<parent record id>#address`. `(sourceFile, sourceRecordId)` must be unique per
  candidate type.
- **Keys.** `providerKey` is `${sourceSystem}:${sourceAccount}`; `propertyKey` is
  `${sourceSystem}:${sourceAccount}:<native property id or derived id>`.
- **PII only in `ContactPii` and `notesRaw`.** Homeowner names, phones and emails go in
  `PropertyCandidate.contact`; free text that may hold them goes in `JobCandidate.notesRaw`, which
  is redacted before it leaves the server. Business phones and emails on a `ProviderCandidate` are
  matching keys, not homeowner PII.
- **Issues never carry PII.** `IngestIssue.code` is a dotted code such as `acme_crm.bad_id`,
  `status.unmapped`, `time.unparseable` or `file.invalid_json`; `message` carries IDs, file names,
  field names and codes only. Create issues with `makeIssue`. Use `error` only for a file the
  adapter cannot read: any error fails `npm run ingest`.
- **Never invent `endAt`.** When the source gives only a start, `endAt` is `null`. The availability
  engine applies its documented default (a 60-minute block with a "default duration assumed"
  reason; see [`data-model.md`](data-model.md)).
- **Statuses through the shared helper.** Map raw statuses with a `statusTable({...})` and
  `mapStatus(table, raw, ref, issues)` into the shared `JobStatus` vocabulary. An unknown value
  becomes `limbo` with a `status.unmapped` warning rather than being dropped. Pass every job
  through `finishJob(job, ctx, issues)`, which applies the limbo rule, the end-before-start and
  long-span checks and `rescheduledFrom`.
- **No schema changes.** If the source has a fact the candidate types cannot hold, stop and raise
  it; don't add a migration or a core branch for one source.

## Checks

```sh
npm test                 # unit tests, including the registry and R2 tests
npm run check            # format, lint, types, unit tests and scrub
npm run ingest           # with the real files in data/sources/acme_crm/
npm run eval             # the six benchmark questions
```

- `npm test` passes, including your new test file and the updated registry test.
- `npm run ingest` prints an `acme_crm: N files read` block, `unclaimed files: none`, and a
  `total:` line with `0 errors` and `0 unmapped statuses`.
- `npm run eval` still reports 6/6.

## Prompt for a coding agent

```text
You are adding a new data source, <name>, to this repository through the adapter contract.
<name> is the snake_case SourceSystem name, <camelName> its camelCase module name and
<folder> its folder under data/sources/. Read AGENTS.md first, then follow
docs/adding-a-source.md exactly, step by step.

Rules:
- If npm run new-source already scaffolded <name>, start from its TODOs: drop the .fails
  marker on 'map your first record' in test/unit/adapters/<camelName>.test.ts and see it fail,
  then write the mapping; replace the invented fixture with ones shaped like the real files.
- Test-first: write test/unit/adapters/<camelName>.test.ts and invented fixtures under
  test/fixtures/<folder>/ first, run npm test and see them fail, then write the adapter.
- Never edit other tests to make them pass. The only existing test you may change is
  test/unit/adapters/registry.test.ts: add the new system to ALL_SYSTEMS, the adapter to the
  arrayContaining list, and raise the count by one.
- No real data in fixtures, docs or commit messages: invented names, 555-01xx phones,
  example.com emails and made-up addresses only. Real files go in data/sources/<folder>/, which
  is git-ignored.
- Change only src/adapters/types.ts (SourceSystem and SOURCE_TRAITS), the new
  src/adapters/<camelName>.ts, src/adapters/registry.ts and the tests and fixtures. No core module
  changes and no migrations; if you think you need one, stop and say why.
- Keep the invariants in the guide: pure parse, UTC "Z" instants, the right TimeBasis,
  SourceRef on every candidate, PII only in ContactPii and notesRaw, no PII in issue
  messages, endAt null when the source has no end, statuses through statusTable/mapStatus
  and finishJob.
- Run npm run check, npm run ingest (0 errors, 0 unmapped statuses, no unclaimed files) and
  npm run eval (6/6). Report the output of each.
```
