# home_services_mcp_server

A data layer and read-only MCP server for a home-services marketplace. It ingests job data from
several differently shaped provider sources (field-service CRMs, a spreadsheet job log, calendar
feeds and provider profiles), normalizes it into one canonical model of providers, properties, jobs
and availability, and exposes it to AI agents through privacy-aware MCP tools.

Status: under construction. The scaffold, database, migrations and the six source adapters are in
place; canonical tables, resolution and MCP tools are next.

## Prerequisites

- Node.js 24 and npm
- Docker (with Compose v2), running
- The source data pack in a local folder (see `DATA_PACK_DIR` below). It is not part of this
  repository.

## Setup

```sh
npm install
npm run setup
```

`npm run setup` starts Postgres (`docker compose up -d --wait`, compose project `hsmcp`, host port
5434), applies migrations and runs ingest. It is safe to run again.

Start the MCP server on stdio:

```sh
npm start --silent   # same as npm run mcp --silent
```

Use `--silent` (or run `npx tsx src/cli/mcp.ts`) in MCP client configs: without it npm prints a
script banner on stdout, which is the protocol channel.

## Environment variables

| Variable                | Default                                       | Purpose                                                                 |
| ----------------------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| `DATABASE_URL`          | `postgres://hsmcp:hsmcp@localhost:5434/hsmcp` | Database the app uses.                                                  |
| `HSMCP_DB_PORT`         | `5434`                                        | Host port for the Compose Postgres; also used by the default URL.       |
| `READER_DATABASE_URL`   | `DATABASE_URL` as `hsmcp_reader`              | Connection `npm start` uses (the read-only role).                       |
| `HSMCP_READER_PASSWORD` | `hsmcp_reader` (local only)                   | Password for `hsmcp_reader` when `READER_DATABASE_URL` is not set.      |
| `DATA_PACK_DIR`         | `_private/data_pack` (in the repo root)       | Folder holding the source data pack.                                    |
| `HS_TODAY`              | `2026-11-02`                                  | The service's "today" (YYYY-MM-DD, America/Chicago). Never the clock.   |
| `HS_NOW`                | midnight of `HS_TODAY`, America/Chicago       | The service's "now". Zone-less values are read as America/Chicago.      |
| `SCRUB_TERMS_FILE`      | `_private/scrub_terms.txt` (in the repo root) | Terms the scrub check forbids in tracked files, branch and commit text. |

All times are stored as instants and presented in America/Chicago.

## Scripts

| Script                     | What it does                                                            |
| -------------------------- | ----------------------------------------------------------------------- |
| `npm run setup`            | Start Postgres, migrate, ingest.                                        |
| `npm run db:up`            | Start Postgres only and wait until healthy.                             |
| `npm run migrate`          | Apply pending SQL migrations from `migrations/`.                        |
| `npm run ingest`           | Migrate, then load the data pack and build the canonical tables.        |
| `npm start`, `npm run mcp` | Run the MCP server on stdio.                                            |
| `npm test`                 | Unit tests (Vitest).                                                    |
| `npm run test:integration` | Postgres integration tests in a throwaway Testcontainers database.      |
| `npm run format`           | Format with Prettier.                                                   |
| `npm run format:check`     | Check formatting.                                                       |
| `npm run lint`             | ESLint with typescript-eslint.                                          |
| `npm run typecheck`        | `tsc --noEmit`.                                                         |
| `npm run scrub`            | Fail if any forbidden term appears in tracked files, branch or commits. |
| `npm run check`            | format:check, lint, typecheck, test and scrub. Runs on `git push`.      |

## Ingest

`npm run ingest` (`src/ingest/pipeline.ts`) applies pending migrations, runs every adapter in
`src/adapters/registry.ts` on the files under `$DATA_PACK_DIR/sources/` that match its patterns,
normalizes and resolves the candidates (`src/normalize/`, `src/resolve/`), and in one transaction
that replaces the previous run stores each candidate with its provenance in `source_records` (and
every issue in `ingest_issues`), the street segments from `$DATA_PACK_DIR/reference/`, and the
canonical tables (providers, properties, jobs, calendar blocks, declared hours, links with method,
confidence and evidence, and homeowner contacts in their own table). It prints a per-source summary
(files read, record counts, jobs by kind and status, issues by severity and code, unclaimed
files), the canonical row counts and the link counts by method. It exits non-zero when any
`error`-severity issue was raised. Running it again leaves the same rows.

The MCP server reads only the `v_*` views (`migrations/0004_read_views.sql` and
`0005_mcp_views.sql`, `0006_job_parents.sql`) as the `hsmcp_reader` role, which has `SELECT` on those views and nothing
else. The views carry no
homeowner names, phones, emails, house numbers or units; every row has a `sources` array of
citations.

## Migrations

Plain SQL files named `NNNN_name.sql` in `migrations/`, applied in order, each in its own
transaction, and recorded in `schema_migrations`. Never edit an applied migration; add a new one.

## Tests

Unit tests need nothing running. Integration tests start a disposable `postgres:16-alpine`
container through Testcontainers, so they need Docker but never touch the dev database.
