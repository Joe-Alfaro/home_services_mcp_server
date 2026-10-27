# home_services_mcp_server

A data layer and read-only, privacy-aware MCP server for a home-services marketplace. Providers
keep their job data in six differently shaped sources: three field-service CRMs (Jobber-style
nested JSON, Housecall Pro-style paged REST, Workiz-style REST), a hand-kept CSV job log, ICS
calendars and self-declared profiles. This project ingests each source through its own adapter,
normalizes everything into one canonical model of providers, homes, jobs and availability,
resolves duplicates with a stated method and confidence, records where every fact came from, and
lets an AI agent answer questions such as "what has been done near this address?" or "which
plumber can come this week?" through seven MCP tools. Agents see a hundred block and zip, never a
homeowner's identity.

## Deliverables

- [x] Repo with one-command setup: [`npm run setup`](#setup)
- [x] Data model: [`docs/data-model.md`](docs/data-model.md)
- [x] Decision log: [`docs/decisions.md`](docs/decisions.md)
- [x] AI-usage note: [`docs/ai-usage.md`](docs/ai-usage.md)
- [x] Eval harness: [`eval/`](eval/README.md), run with `npm run eval`
- [ ] Demo video: _link to be added_

Requirements and done checks: [`docs/requirements/home-services-mcp.md`](docs/requirements/home-services-mcp.md).
Design: [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Prerequisites

- Node.js 24 and npm
- Docker with Compose v2, running
- The source data pack in a local folder (see `DATA_PACK_DIR` below). It is not part of this
  repository.

## Setup

```sh
npm install
npm run setup
```

`npm run setup` starts Postgres (`docker compose up -d --wait`, compose project `hsmcp`, host port
5434), applies migrations, ingests the data pack and prints a per-source summary. It is safe to
run again: a second run leaves the same rows.

## Connect an MCP client

The server speaks MCP over stdio and connects to Postgres as the read-only `hsmcp_reader` role.

```sh
npm start --silent   # same as: npx tsx src/cli/mcp.ts
```

Use `--silent` (or call `tsx` directly) in client configs: without it npm prints a banner on
stdout, which is the protocol channel. For a client that takes a JSON config (Claude Desktop,
Claude Code's `.mcp.json` and similar):

```json
{
  "mcpServers": {
    "home-services": {
      "command": "npx",
      "args": ["tsx", "src/cli/mcp.ts"],
      "cwd": "/absolute/path/to/home_services_mcp_server",
      "env": { "HS_TODAY": "2026-11-02" }
    }
  }
}
```

If your client has no `cwd` option, use `"args": ["tsx", "/absolute/path/to/home_services_mcp_server/src/cli/mcp.ts"]`.

## Tools

| Tool                              | Use it for                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `search_job_history_near_address` | Completed work within a radius of an address, over a period, grouped by trade. |
| `find_providers`                  | Providers of a trade who worked in a zip and have openings in a window.        |
| `get_scheduled_work_on_block`     | Upcoming work on one hundred block of a street.                                |
| `get_provider_profile`            | Everything about one provider: trades, service area, history, next openings.   |
| `get_property_service_history`    | Who serviced one home, when, and what was done.                                |
| `rank_providers_for_job`          | A scored, explained ranking of providers for a specific job.                   |
| `get_provider_openings`           | One provider's openings in a date range, with confidence and reasons.          |

Every response item cites its sources (`sourceSystem`, `sourceFile`, `sourceRecordId`); times are
ISO strings with the America/Chicago offset.

## Eval

```sh
npm run eval
```

Starts the server over stdio, asks the six benchmark questions with one call each to the intended
tool (no LLM, no retries), compares each answer with `eval/expected/qN.json`, and prints PASS/FAIL
per question and the pass rate. It exits 1 when any question fails. Run `npm run setup` first. See
[`eval/README.md`](eval/README.md) for the calls and what each check reads.

## Environment variables

| Variable                | Default                                       | Purpose                                                                 |
| ----------------------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| `DATABASE_URL`          | `postgres://hsmcp:hsmcp@localhost:5434/hsmcp` | Database setup and ingest use. The database must exist.                 |
| `HSMCP_DB_PORT`         | `5434`                                        | Host port for the Compose Postgres; also used by the default URL.       |
| `READER_DATABASE_URL`   | `DATABASE_URL` as `hsmcp_reader`              | Connection `npm start` uses (the read-only role).                       |
| `HSMCP_READER_PASSWORD` | `hsmcp_reader` (local only)                   | Password for `hsmcp_reader` when `READER_DATABASE_URL` is not set.      |
| `DATA_PACK_DIR`         | `_private/data_pack` (in the repo root)       | Folder holding the source data pack.                                    |
| `HS_TODAY`              | `2026-11-02`                                  | The service's "today" (YYYY-MM-DD, America/Chicago). Never the clock.   |
| `HS_NOW`                | midnight of `HS_TODAY`, America/Chicago       | The service's "now". Zone-less values are read as America/Chicago.      |
| `SCRUB_TERMS_FILE`      | `_private/scrub_terms.txt` (in the repo root) | Terms the scrub check forbids in tracked files, branch and commit text. |

## Scripts

| Script                     | What it does                                                            |
| -------------------------- | ----------------------------------------------------------------------- |
| `npm run setup`            | Start Postgres, migrate, ingest.                                        |
| `npm run db:up`            | Start Postgres only and wait until healthy.                             |
| `npm run migrate`          | Apply pending SQL migrations from `migrations/`.                        |
| `npm run ingest`           | Migrate, then load the data pack and build the canonical tables.        |
| `npm start`, `npm run mcp` | Run the MCP server on stdio.                                            |
| `npm run eval`             | Run the six benchmark questions through the server and report a score.  |
| `npm test`                 | Unit tests (Vitest).                                                    |
| `npm run test:integration` | Postgres integration tests in a throwaway Testcontainers database.      |
| `npm run format`           | Format with Prettier.                                                   |
| `npm run format:check`     | Check formatting.                                                       |
| `npm run lint`             | ESLint with typescript-eslint.                                          |
| `npm run typecheck`        | `tsc --noEmit`.                                                         |
| `npm run scrub`            | Fail if any forbidden term appears in tracked files, branch or commits. |
| `npm run check`            | format:check, lint, typecheck, test and scrub. Runs on `git push`.      |

## How it fits together

`npm run ingest` (`src/ingest/pipeline.ts`) runs every adapter in `src/adapters/registry.ts` on
the files under `$DATA_PACK_DIR/sources/`, normalizes and resolves the candidates
(`src/normalize/`, `src/resolve/`), and in one transaction that replaces the previous run stores
each record with its provenance, the street reference, and the canonical tables. It exits non-zero
when any `error`-severity issue was raised.

The MCP server (`src/mcp/`) reads only the `v_*` views as `hsmcp_reader`, which has `SELECT` on
those views and nothing else. The views carry no homeowner names, phones, emails, house numbers or
units. Availability is computed per request by `src/availability/`. See
[`docs/data-model.md`](docs/data-model.md) for the schema, matching and availability rules.

Migrations are plain SQL files named `NNNN_name.sql` in `migrations/`, applied in order and
recorded in `schema_migrations`. Never edit an applied migration; add a new one.

## Tests

Unit tests need nothing running. Integration tests start a disposable Postgres container through
Testcontainers, so they need Docker but never touch the dev database.
