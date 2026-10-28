# AGENTS.md

Conventions for coding agents (and people) working in this repository. The [README](README.md)
covers setup and the MCP tools; [`ARCHITECTURE.md`](ARCHITECTURE.md) and
[`docs/data-model.md`](docs/data-model.md) cover the design.

## Stack

TypeScript on Node 24 (run with `tsx`, ES modules), Postgres in local Docker (Compose project
`hsmcp`, host port 5434), the official `@modelcontextprotocol/sdk` over stdio, zod, luxon, Vitest,
ESLint (typescript-eslint) and Prettier. npm for packages. No paid services and no LLM API keys.

## Commands

| Command                    | What it does                                                                      |
| -------------------------- | --------------------------------------------------------------------------------- |
| `npm install`              | Install dependencies.                                                             |
| `npm run setup`            | Start Postgres, migrate and ingest the data pack (`data/` or `DATA_PACK_DIR`).    |
| `npm start`                | Run the MCP server on stdio (use `npm start --silent` in client configs).         |
| `npm test`                 | Unit tests. Need nothing running.                                                 |
| `npm run test:integration` | Postgres integration tests in a throwaway Testcontainers database (needs Docker). |
| `npm run eval`             | The six benchmark questions through the server; expects 6/6. Run setup first.     |
| `npm run check`            | Format check, lint, type check, unit tests and scrub. Must pass before a commit.  |

## Layout

- `src/adapters/`: one pure adapter per source, the contract in `types.ts`, the list in
  `registry.ts`.
- `src/normalize/`, `src/resolve/`: normalization, dedupe and matching.
- `src/ingest/`, `src/db/`, `src/cli/`: the ingest pipeline, database writes and entry points.
- `src/availability/`: openings computed per request.
- `src/mcp/`: the MCP server and its tools.
- `migrations/`: plain SQL `NNNN_name.sql`, applied in order. Never edit an applied migration; add
  a new one.
- `test/unit/`, `test/integration/`, `test/fixtures/`: tests and invented fixtures.
- `eval/`: the benchmark harness and expected answers.
- `data/`: the local data pack. Git-ignored except its README.

## Rules

- **Test-first.** Write or change the failing test, see it fail, then make it pass.
- **Never edit a test to make it pass.** If a test looks wrong, stop and say why. Never skip or
  weaken tests or lint rules, and never commit with `--no-verify`.
- **No PII and no data-pack rows** in fixtures, tests, docs or commit messages. Fixtures are small
  and hand-made with invented names, `555-01xx` phones, `example.com` emails and made-up
  addresses. `data/` is git-ignored: never commit the data pack.
- **Times are instants.** Store and pass UTC instants with a trailing `Z`; present them in
  America/Chicago with the offset. Zone-less source times are America/Chicago and DST-aware.
- **"Today" comes from `HS_TODAY`** (default `2026-11-02`) and "now" from `HS_NOW`, never the
  system clock.
- **The MCP server is read-only.** It connects as `hsmcp_reader`, which can only `SELECT` the `v_*`
  views. Agents see a hundred block and zip, never homeowner names, phones or emails.
- **No source-specific branches in core code.** Core modules read source roles from
  `SOURCE_TRAITS`, never a source-system name.
- **The scrub check is maintainer-only.** `npm run scrub` (part of `npm run check`) is skipped with
  a notice when no terms file is present. Contributors don't need it.

## Adding a data source

Start with `npm run new-source -- <name> --role <role>` (`--dry-run` first to see the plan), then
follow [`docs/adding-a-source.md`](docs/adding-a-source.md): the exact steps and files, the
invariants an adapter keeps, the checks, and a prompt to hand to a coding agent.
