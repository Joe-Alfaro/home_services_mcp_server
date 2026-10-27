# home_services_mcp_server

A data layer and read-only MCP server for a home-services marketplace. It ingests job data from
several differently shaped provider sources (field-service CRMs, a spreadsheet job log, calendar
feeds and provider profiles), normalizes it into one canonical model of providers, properties, jobs
and availability, and exposes it to AI agents through privacy-aware MCP tools.

Status: under construction. The scaffold, database and migrations are in place; source adapters and
MCP tools are next.

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

| Variable           | Default                                       | Purpose                                                                 |
| ------------------ | --------------------------------------------- | ----------------------------------------------------------------------- |
| `DATABASE_URL`     | `postgres://hsmcp:hsmcp@localhost:5434/hsmcp` | Database the app uses.                                                  |
| `HSMCP_DB_PORT`    | `5434`                                        | Host port for the Compose Postgres; also used by the default URL.       |
| `DATA_PACK_DIR`    | `_private/data_pack` (in the repo root)       | Folder holding the source data pack.                                    |
| `HS_TODAY`         | `2026-11-02`                                  | The service's "today" (YYYY-MM-DD, America/Chicago). Never the clock.   |
| `HS_NOW`           | midnight of `HS_TODAY`, America/Chicago       | The service's "now". Zone-less values are read as America/Chicago.      |
| `SCRUB_TERMS_FILE` | `_private/scrub_terms.txt` (in the repo root) | Terms the scrub check forbids in tracked files, branch and commit text. |

All times are stored as instants and presented in America/Chicago.

## Scripts

| Script                     | What it does                                                            |
| -------------------------- | ----------------------------------------------------------------------- |
| `npm run setup`            | Start Postgres, migrate, ingest.                                        |
| `npm run db:up`            | Start Postgres only and wait until healthy.                             |
| `npm run migrate`          | Apply pending SQL migrations from `migrations/`.                        |
| `npm run ingest`           | Load the data pack into the database.                                   |
| `npm start`, `npm run mcp` | Run the MCP server on stdio.                                            |
| `npm test`                 | Unit tests (Vitest).                                                    |
| `npm run test:integration` | Postgres integration tests in a throwaway Testcontainers database.      |
| `npm run format`           | Format with Prettier.                                                   |
| `npm run format:check`     | Check formatting.                                                       |
| `npm run lint`             | ESLint with typescript-eslint.                                          |
| `npm run typecheck`        | `tsc --noEmit`.                                                         |
| `npm run scrub`            | Fail if any forbidden term appears in tracked files, branch or commits. |
| `npm run check`            | format:check, lint, typecheck, test and scrub. Runs on `git push`.      |

## Migrations

Plain SQL files named `NNNN_name.sql` in `migrations/`, applied in order, each in its own
transaction, and recorded in `schema_migrations`. Never edit an applied migration; add a new one.

## Tests

Unit tests need nothing running. Integration tests start a disposable `postgres:16-alpine`
container through Testcontainers, so they need Docker but never touch the dev database.
