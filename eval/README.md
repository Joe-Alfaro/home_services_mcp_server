# Eval harness (R29)

`npm run eval` starts the MCP server the way `npm start` does (stdio, `HS_TODAY=2026-11-02`), asks
the six benchmark questions with one call each to the intended tool (R18 d: no retries, no LLM),
compares each response with `expected/qN.json`, prints PASS/FAIL per question with the
differences, and prints the pass rate. It exits 1 when any question fails. Before `npm run setup`
has loaded the data pack, or before a tool exists, each question fails with `server not ready` or
`tool not found` rather than crashing.

Q1 is answered in summary mode: its pass/fail comes from the per-trade counts of the first,
default call, and that call's response must be under 50 KB so a live agent can read it. The
harness then reads the paged job list to the end with follow-up calls (`limit: 100`, then
`cursor: <nextCursor>` until `nextCursor` is null) and fails Q1 unless the pages hold exactly as
many jobs per trade as the summary counts and cite every expected non-CSV job ID exactly once.

The expected answers were derived from the raw data pack by a separate pass that never read the
implementation. Each file has a `derivation` (how) and a `tolerance` (what may differ) field.
Availability follows the crew-aware model (capacity = min(crew size, max observed concurrency)).

## Calls

| Q   | Tool                              | Arguments                                                                                                 |
| --- | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Q1  | `search_job_history_near_address` | `address: '4512 Live Oak St, Dallas, TX 75204'`, `radiusMiles: 0.5`, `lastMonths: 24`, `groupBy: 'trade'` |
| Q2  | `find_providers`                  | `trade: 'handyman'`, `workedInZip: '75214'`, `minOpeningMinutes: 120`, `window: 'next_3_days'`            |
| Q3  | `get_scheduled_work_on_block`     | `street: 'Live Oak St'`, `blockNumber: 4500`, `zip: '75204'`, `nextDays: 14`                              |
| Q4  | `get_provider_profile`            | `providerName: 'Lone Star Plumbing'`, `openingsLimit: 3`                                                  |
| Q5  | `get_property_service_history`    | `address: '5823 Belmont Ave, Dallas, TX 75206'`                                                           |
| Q6  | `rank_providers_for_job`          | `trade: 'plumbing'`, `service: 'water heater replacement'`, `nearZip: '75206'`, `window: 'this_week'`     |

## Response shape the checks read

The answer is the tool result's `structuredContent`, or else its first text block parsed as JSON.
The checks look for these fields anywhere in the response (first match, depth first):

- **Provider name:** `providerName`, `businessName`, `name`, or `provider` (a string or `{ name }`).
- **Times:** `start` / `end` (also `startsAt`, `startTime`, `scheduledStart`, and the `end`
  equivalents); ISO strings with the America/Chicago offset in force at that instant.
- **Q1:** an array of `{ trade, count, sources }` (`jobCount`, `jobs` or `total` also read as count);
  a top-level `total`, when present, must be their sum. The paged list is `jobs: [{ trade, sources,
… }]` with `nextCursor` (a string, or null on the last page).
- **Q2:** an array of providers, each with `openings: [{ start, end, confidence }]`.
- **Q3, Q5:** an array of items with a provider name and `start`; `kind` (or `type`, `label`,
  `category`) says `estimate`; `status` uses the canonical values.
- **Q4:** one provider object with top-level `sources`; `trades`; an object with `declared` /
  `observed` (or `declaredZips` / `observedZips`) zips as strings, `{ zip }` items or zip keys; an
  object with numeric `completed`, `scheduled`, `cancelled` (and optionally `limbo`, `unscheduled`,
  `estimates`); `openings: [{ start, end, confidence }]`.
- **Q6:** an ordered array of `{ name, score, factors: [{ …, sources }], confidence }`, optionally
  with `rank`.

Every response must also pass the common checks: every object inside an array carries
`sources: [{ sourceSystem, sourceFile, sourceRecordId }]` (arrays under `openings`, `reasons`,
`aliases` and `sources` are exempt) (R19); no phone- or email-shaped string (R17); every date-time
has a `-05:00` / `-06:00` offset (R12 e); and no house number except the one in the question
(hundred blocks such as "4500 block" are fine) (R17 c).
