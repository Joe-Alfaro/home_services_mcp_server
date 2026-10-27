-- Placeholder foundation: the provenance table every canonical record joins to.
-- Canonical tables (providers, properties, jobs, calendar_blocks, ...) arrive in later migrations
-- following ARCHITECTURE.md.

CREATE TABLE source_records (
  id               bigserial PRIMARY KEY,
  source_system    text        NOT NULL,
  source_file      text        NOT NULL,
  source_record_id text        NOT NULL,
  record_kind      text        NOT NULL,
  payload          jsonb       NOT NULL,
  ingested_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_system, source_file, source_record_id, record_kind)
);
