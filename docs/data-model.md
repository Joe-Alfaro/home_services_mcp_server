# Data model

How six sources become one canonical model, how duplicates resolve, what "available" means and
what an agent may see. SQL is in `migrations/`; the constants are in `src/resolve/`,
`src/normalize/` and `src/availability/`. Each data trap (G1-G28) and its handling is listed in
[`decisions.md`](decisions.md#how-each-trap-is-handled).

## Schema

One transaction per ingest stores every source record with its provenance (system, account,
file, record ID), then builds canonical rows with stable hashed IDs that reveal nothing.

| Table                               | Holds                                                              |
| ----------------------------------- | ------------------------------------------------------------------ |
| `providers`                         | Name, aliases, trades, `does_not_do`, zips, crew, hours.           |
| `properties`                        | Address key, hundred block, lat/lon, `geocode_method`.             |
| `jobs`                              | Kind `job`/`estimate`/`visit`, parent, status, trade, cents.       |
| `calendar_blocks`                   | One row per occurrence: busy, category, status, mirror job.        |
| `declared_hours`                    | Weekly local windows, parse quality, `always_open` (24/7).         |
| `*_links` (provider, property, job) | Canonical row ↔ source record: `method`, `confidence`, `evidence`. |
| `provider_conflicts`                | Profile versus observed data, citing the records.                  |
| `match_decisions`                   | Accepted and rejected merges with their score.                     |
| `homeowner_contacts`                | Homeowner names, phones, emails. Invisible to the server.          |
| `source_records`, `ingest_issues`   | Raw provenance and every ingest warning.                           |
| `street_segments`                   | The geocoding reference.                                           |

No column names a source, so a seventh source needs an adapter, not a schema change. A
Jobber-style job becomes a parent row plus one row per listed visit; rules are never expanded.

The server connects as `hsmcp_reader`, which can only read the `v_*` views. They drop house
numbers and units, hash the address key for exact-home matching, and attach `sources` to every
row, so the database enforces read-only and PII-free.

## Duplicate resolution

Matching is deterministic and conservative: a wrong merge corrupts two answers; a missed one
leaves two rows an agent can still read. When tiers overlap, the lowest wins.

**Providers** (`src/resolve/providers.ts`). Same 10-digit phone: 0.95. Same business email domain
(free-mail ignored) or website host: 0.9. Same normalized name, compatible trades, no conflicting
phones: 0.8. A calendar known only by its owner's name joins that provider: 0.8. Names alone
never merge, and owner or technician names are never a key: they repeat across businesses.

**Properties** (`src/resolve/properties.ts`, `src/normalize/address.ts`). The key is house
number, street (directions folded), USPS street type, unit (`Apt 4`, `#4` → `4`) and 5-digit zip.
Exact key: 1.0. A street typo matched to the reference by edit distance: 0.9 for one edit, 0.8 for
two (long names only). Zip inferred from a unique street segment: 0.85. Free-text CSV address:
0.8. Ambiguous typos, different units and other streets at the same number never match.

**Jobs** (`src/resolve/jobs.ts`). Identical CSV rows: one job with `duplicate_count`, 0.95. Same
provider and home starting within 30 minutes across sources: 0.8. An approved estimate and the
job made from it: one service, 1.0. A calendar event mirroring a job within 30 minutes: 0.8, or
0.6 when the text disagrees; never when both addresses are known and differ.

## Availability

**Openings = declared hours − bookings − calendar blocks** (`src/availability/engine.ts`).

- **Hours:** the profile's; if missing, unparseable or 24/7, inferred from 90 days of work.
- **Bookings:** every job, visit and estimate with a slot, not cancelled or completed, from every
  CRM and the CSV log; multi-day spans clipped to each day. Undated work blocks nothing.
- **Missing end:** a booking with a start but no end blocks a flat 60 minutes for every trade,
  with a "default duration assumed" reason but no confidence drop of its own (see
  [known limits](decisions.md#known-limits)).
- **Calendar blocks:** busy events, including all-day and recurring ones; tentative holds block.
- **Capacity:** concurrent bookings < min(declared crew, most ever observed at once), minimum 1.

Confidence starts `high` and only drops, with a reason. `low`: inferred hours, or a tentative
hold, limbo or unscheduled item that day. `medium`: an opening that
exists only because a second crew lane is free, a declared crew larger than observed concurrency,
work outside declared hours, or a CSV-only booking. Anything any source calls busy blocks.

## Privacy

Agents need location for "near me" and "on my street", not identity. A property is shown as a
hundred block plus zip ("4500 block of Live Oak St", 75204); a full address only when the caller
supplied it. Contacts sit in `homeowner_contacts`, which the reader role can't select. Free text is
redacted of phones, emails and homeowner names, and calendar names never reach a response.

## Time

Times are stored as instants (`timestamptz`) and shown with the America/Chicago offset in force
(`-05:00` or `-06:00`), never bare UTC. Zone-less source times are read as Chicago wall time with
luxon: on the 2026-11-01 DST change the repeated hour takes the earlier (CDT) instant. All-day
events cover the local day; windows run between local midnights. "Today" is `HS_TODAY` (default
2026-11-02), never the system clock.
