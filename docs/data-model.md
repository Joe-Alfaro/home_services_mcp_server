# Data model

How six provider sources become one canonical model, how duplicates are resolved, what
"available" means and what an agent may see. SQL is in `migrations/`; the constants quoted here
are in `src/resolve/`, `src/normalize/` and `src/availability/`.

## Schema

Each ingest is one transaction: every source record goes to `source_records` with its provenance
(system, account, file, native record ID, ingest time), then the canonical rows are built from
them. IDs are stable hashes (`prov_…`, `job_…`), so re-running setup leaves the same rows and an ID
reveals no address or account name.

| Table                                                | Holds                                                                                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers`                                          | One business: display name, aliases, trades, `does_not_do`, declared and observed service zips, crew size, raw and parsed hours, lowest link confidence.                  |
| `properties`                                         | One home: normalized address key (number, street, type, unit, zip), `zip_inferred`, hundred block, lat/lon, `geocode_method` (`interpolated` or `none`), `in_target_zip`. |
| `jobs`                                               | Kind `job`, `estimate` or `visit`; `parent_job_id` ties visits to their parent job; canonical `status` plus `status_raw`; trade, service, instants, amount in cents.      |
| `calendar_blocks`                                    | One row per calendar occurrence: busy flag, category (`work`, `personal`, `unknown`), status (`confirmed`, `tentative`, `cancelled`), the job it mirrors, if any.         |
| `declared_hours`                                     | Weekly windows from a provider profile (ISO weekday, local start/end), how well they parsed, and `always_open` for a 24/7 claim.                                          |
| `provider_links`, `property_links`, `job_links`      | Canonical row ↔ source record, with `method`, `confidence` in [0, 1] and `evidence` JSON. Every canonical row has at least one.                                           |
| `provider_conflicts`                                 | Profile versus observed data: `trade`, `service_area`, `hours`, `crm`, citing the records involved.                                                                       |
| `match_decisions`                                    | Accepted and rejected merge candidates with their score, so a non-merge is explainable too.                                                                               |
| `homeowner_contacts`                                 | Homeowner names, phones and emails. The only place they are stored, and invisible to the server.                                                                          |
| `street_segments`, `source_records`, `ingest_issues` | The geocoding reference, raw provenance, and every warning raised during ingest.                                                                                          |

No column is named after a source, so a seventh source needs an adapter, not a schema change.

**Parents and visits.** A Jobber-style job with visits becomes one parent row plus one row per
visit. Tools count the visits, not the container, and cite the parent's record next to them. Only listed visits exist; recurrence rules are never expanded.

**Read views and the reader role.** The MCP server connects as `hsmcp_reader`, which has `SELECT`
on the `v_*` views and nothing else: no tables, no `homeowner_contacts`, no `source_records`, no
writes. The views drop house numbers and units, expose a SHA-256 of the address key for exact-home
matching, and attach a `sources` array of `{ sourceSystem, sourceFile, sourceRecordId }` to every
row. The database enforces read-only and PII-free, not tool code remembering to filter.

## Duplicate resolution

Matching is deterministic and conservative: a wrong merge corrupts every answer about both businesses or homes; a missed merge leaves two rows an agent can still reason about.
When several tiers apply, the lowest confidence wins.

**Providers** (`src/resolve/providers.ts`). Same 10-digit business phone: 0.95. Same business
email domain (free-mail ignored) or website host: 0.9. Same normalized name with compatible trades
and no conflicting phones: 0.8. A calendar whose only identity is its owner's name joins that one
provider: 0.8. Clusters are transitive, and each job record links to its provider at the account's
own confidence. Name similarity alone never merges, so two businesses sharing "Lone Star" stay
apart; owner and technician names are never a key, because they repeat across businesses.

**Properties** (`src/resolve/properties.ts`, `src/normalize/address.ts`). The key is house
number, street name (directions folded), USPS street type, unit (`Apt 4`, `#4`, `Unit 4` → `4`)
and 5-digit zip. Exact key: 1.0. Zip inferred from the street reference (only when exactly one
target-zip segment holds that number and street): 0.85. Free-text CSV address: 0.8. A street typo matched to the reference by edit distance (transpositions count once; two edits only for long names, none for names under 5 letters): 0.9 for one edit, 0.8 for two. A
typo equally close to two streets stays unmatched. Different units never merge; another street at
the same number never matches.

**Jobs** (`src/resolve/jobs.ts`). Identical CSV rows (date, time, address, text, amount, status,
notes): one job with `duplicate_count`, 0.95. The same provider and home starting within 30
minutes across sources: 0.8. An approved estimate and the job created from it: one service, 1.0.
A calendar event mirroring a job of the same provider within 30 minutes: 0.8, or 0.6 when the text
disagrees; never when both addresses are known and differ.

## Availability

**Openings = declared hours − bookings − calendar blocks**, computed per request by a pure engine
(`src/availability/engine.ts`) from the views.

- **Hours:** the profile's weekly hours, materialized per local date. With none, an unparseable
  string or a 24/7 claim, hours are inferred from the last 90 days of observed work and every
  opening is `low`.
- **Bookings:** every job, visit and estimate with a slot that isn't cancelled or completed
  (scheduled, in progress, on hold, limbo), from every CRM and the CSV log. A missing end gets 60
  minutes and a reason. Multi-day spans are clipped to each day's hours. A rescheduled job blocks
  only its current slot.
- **Calendar blocks:** busy events, including all-day and recurring occurrences. Transparent and
  cancelled events don't block; tentative holds do.
- **Crew-aware capacity:** a time is open while concurrent bookings < min(declared crew size,
  most bookings ever observed at once), minimum 1. Trusting the profile alone would invent
  capacity; ignoring crews would hide real openings.

Confidence starts `high` and only goes down; each drop adds a reason. `low`: inferred hours, a
tentative hold, a limbo item or an unscheduled item with a start on that day. `medium`: an opening
that exists only because a second crew lane is free, a declared crew larger than observed
concurrency, work observed outside declared hours, or a booking seen only in the CSV log. When
sources disagree the cautious answer wins: anything any source calls busy blocks.

## Privacy

Agents need location to answer "near me" and "on my street", not identity. Every property is
shown as a hundred block plus zip ("4500 block of Live Oak St", 75204). A full address appears only
when the caller supplied it, so echoing it reveals nothing new. Names, phones and
emails sit in `homeowner_contacts`, which the reader role cannot select. Free text (job
descriptions, calendar summaries) is redacted of phones, emails and known homeowner names before
it is stored, and house numbers are rewritten to blocks on the way out. Calendar names, which are
often the owner's name, never reach a response.

## Time

Every time is stored as an instant (`timestamptz`), so a UTC CRM visit and a Chicago calendar
event at the same moment compare equal, and is presented with the America/Chicago offset in force
(`-05:00` or `-06:00`), never bare UTC: a fixed −6 h would be wrong for half the year. Zone-less source times
(Housecall Pro-style schedules, Workiz-style jobs, the CSV log, floating ICS times) are read as
Chicago wall time with luxon, so the 2026-11-01 DST change is handled: the repeated 01:00–02:00
hour takes the earlier (CDT) instant, and a nonexistent spring-forward time moves forward. All-day
events cover the whole local day, which is 25 hours on fall-back day. Relative windows ("next 3
days", "this week", "last 24 months") run between local midnights.

"Today" is `HS_TODAY` (default 2026-11-02) and "now" is `HS_NOW` (default local midnight of
today). The system clock is never read for answers, so a fixed snapshot answers the same way
tomorrow and tests are deterministic.
