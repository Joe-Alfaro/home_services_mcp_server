# Decisions

The choices that shaped this system, what was left out, where it stops scaling, and what comes
next. The data model itself is in [`data-model.md`](data-model.md); requirement IDs (R…, G…)
refer to [`requirements/home-services-mcp.md`](requirements/home-services-mcp.md).

## What was chosen

**Stack: TypeScript on Node 24, Postgres in local Docker, the official MCP SDK over stdio.** One
language covers adapters, server, eval and tests, and the adapter contract is checked by the
compiler. Postgres gives real constraints, `timestamptz` instants and, most importantly, a
read-only role, so "the server can't write" and "the server can't see homeowner contacts" are
enforced by the database. Plain SQL migrations and no ORM keep the documented schema the real one.
luxon handles the America/Chicago DST change; zod gives tight tool parameters and precise errors.
No paid services, no network calls, no LLM keys: `npm run setup` works offline.

**Canonical model: one row per real-world thing, with every source record linked to it.**
Adapters are pure functions from file contents to candidate records; everything source-specific
(status vocabularies, money units, time conventions, which records are estimates or visits) stays
in the adapter. The canonical tables have no source-named columns. Provenance and match confidence
live in link tables, so any answer can be traced back to a file and record ID.

**Matching: deterministic tiers, conservative, explainable.** Phone first, then email domain or
website, then same name with compatible trades; names alone never merge. Addresses match on a
normalized key with a bounded street-typo tolerance against the street reference. Every link
records method, confidence and evidence; rejected candidates are kept too. A learned or fuzzy
matcher was rejected: on this data the deterministic tiers resolve every known duplicate, and a
merge you can't explain is worse than a split you can see.

**Availability: declared hours minus everything any source calls busy, crew-aware.** The cautious
answer wins when sources disagree. Capacity is min(declared crew, most bookings observed at once),
so a profile can't invent crews it has never used. Every opening carries `high`, `medium` or
`low` confidence and the reasons, so the agent can say how sure it is.

**Privacy: hundred block plus zip.** Agents get enough location to answer "near" and "on my
street" questions, and nothing that identifies a homeowner. A full address is echoed only when the
caller supplied it. Contacts sit in a table the server's role can't read.

**Tools: seven, one per question shape.** `search_job_history_near_address`, `find_providers`,
`get_scheduled_work_on_block`, `get_provider_profile`, `get_property_service_history`,
`rank_providers_for_job`, `get_provider_openings`. Each description says when to use it, when not
to (naming the better tool), its parameters with units, and an example. Parameters are enums,
5-digit zips and bounded ranges; a bad input names the field and the accepted values. Fewer,
sharper tools make the agent's first pick the right one.

**Eval: a scripted MCP client, no LLM.** `npm run eval` starts the real server over stdio, makes
one call per benchmark question to the intended tool, and checks the response against expected
answers that a separate pass derived from the raw data without reading the implementation. Each
expected file records how it was derived and what tolerance applies. A deterministic harness
catches regressions; an LLM in the loop would make failures unreproducible.

**Time: instants in storage, Chicago in presentation, a configured "today".** Never the system
clock, so answers about a fixed snapshot don't drift.

## What was cut

- **R30, a seventh source in under an hour.** The adapter contract is built for it, but it wasn't
  exercised with a real new source.
- **R31, incremental sync.** Setup rebuilds everything in one transaction. Simple and idempotent,
  but it re-reads every source on every run.
- **R32, access tiers** (internal versus partner detail, enforced by the server).
- **Booking, payments and messaging.** The server is read-only by design.
- **Any UI.** An agent chat is the interface.
- **Deploys, hosted environments and live CRM or geocoder APIs.** Everything runs locally from the
  data pack.
- **PostGIS and an ORM.** A half-mile haversine over a few thousand homes is cheap without them.

## What breaks at 10,000 providers

- **Full rebuilds.** One transaction that re-parses every file and re-resolves every record is
  fine at ~25,000 source records; at hundreds of times that, setup takes hours and holds a huge
  transaction. Incremental, per-source sync (R31) becomes mandatory.
- **In-memory resolution.** Adapters load whole files and resolvers cluster in memory. Provider
  and property matching need blocking keys (phone, zip plus street) and streaming.
- **Phone as the strongest key.** Shared answering services and franchise call centers will merge
  unrelated businesses. Phone matches need a second signal at that scale.
- **Availability on every request.** `find_providers` and `rank_providers_for_job` compute openings
  for every provider of a trade per call. With thousands per trade that is too slow; free/busy
  needs to be precomputed per provider and refreshed on change.
- **Radius search.** A haversine scan over every property works for 3,000 homes, not millions.
  This needs a spatial index (PostGIS or a geohash column).
- **Geocoding coverage.** The street reference covers a few target zips; elsewhere homes have no
  coordinates and fall out of radius answers. A real geocoder (with a cache) is needed.
- **Aggregated source views.** The view that builds `sources` arrays for every entity is already
  the slowest query path; at scale citations need to be stored, not aggregated on read.
- **Response size.** History answers that list every job grow with the data; tools need summaries
  and paging by default.
- **The curated trade phrase map.** It covers this data's job titles; thousands of providers bring
  new phrasings that need a maintained map or a reviewed classifier.

## What to build in week 2

1. **R30: add a seventh source** through the adapter contract and time it, to prove the contract.
2. **R31: incremental sync.** Re-ingest one changed source without a full rebuild, including a job
   that moved from upcoming to completed, keeping canonical IDs stable.
3. **R32: access tiers.** Internal versus partner detail levels, enforced by separate database
   roles and views, not by the agent.
4. **A second, independent availability model** for the eval (see known limits), with exact
   expected opening boundaries.
5. **Job length from data.** Estimate durations per service from completed jobs instead of fixed
   defaults, and let callers set a minimum opening length on every openings tool.
6. **Fuzzy street matching outside the reference**, so the remaining calendar-mirror splits merge.
7. **Precomputed free/busy and a spatial index**, the first two scaling fixes above.

## Known limits

- **The expected answers share the crew-aware availability model with the implementation.** The
  expected openings for Q2, Q4 and Q6 were derived independently, but using the same definition
  of capacity, and the opening checks are loose (no exact boundaries). An error in the model
  itself, rather than in the code, would not be caught by the eval.
- **Crew-aware openings can look surprising.** A provider with a four-person crew and eleven
  bookings in a day can still show a long opening, because no more than three overlap at once.
  That is correct as "at least one crew is free", and those openings are capped at `medium` with a
  "free crew lane" reason, but an agent should say so rather than imply the whole business is idle.
- **Q6 is sensitive to the default job length.** A water heater replacement defaults to 180
  minutes when judging openings. The data suggests closer to four or five hours; at 270 minutes the
  lower half of the ranking reorders. Callers can pass `jobMinutes`. Q6 also ranks only providers
  whose declared trade is plumbing, so water-heater jobs done by handymen don't count.
- **Two street-typo mirrors still split.** Street typos are corrected only against the street
  reference, which covers the target zips. Two jobs whose street is misspelled outside that area
  don't merge with the calendar event for the same visit, so each shows as two bookings.
- **Openings tools have a fixed minimum length** of 30 minutes for profile openings, so a "next 3
  openings" answer can include a slot too short for real work.
- **Setup assumes the database exists.** Pointing `DATABASE_URL` at a new database name requires
  creating it first.
