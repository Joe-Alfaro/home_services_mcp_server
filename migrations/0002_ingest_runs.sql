-- Ingest runs and adapter output. source_records follows ARCHITECTURE.md: every candidate an
-- adapter emits is stored with its provenance and its full candidate payload, so canonical
-- tables (M1) can trace back to it. The 0001 placeholder held no data, so it is replaced.
-- payload can hold homeowner contact PII: no reader role is ever granted these tables.

DROP TABLE source_records;

CREATE TABLE ingest_runs (
  id            bigserial   PRIMARY KEY,
  started_at    timestamptz NOT NULL,
  today         date        NOT NULL,
  now           timestamptz NOT NULL,
  data_pack_dir text        NOT NULL,
  summary       jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE source_records (
  id               bigserial   PRIMARY KEY,
  run_id           bigint      NOT NULL REFERENCES ingest_runs (id) ON DELETE CASCADE,
  source_system    text        NOT NULL,
  source_account   text        NOT NULL,
  source_file      text        NOT NULL,
  source_record_id text        NOT NULL,
  record_type      text        NOT NULL,
  ingested_at      timestamptz NOT NULL,
  payload          jsonb       NOT NULL,
  -- record_type is part of the key: a profile's provider and declared hours share profile_id.
  UNIQUE (run_id, source_system, source_file, source_record_id, record_type)
);

CREATE INDEX source_records_system_idx ON source_records (run_id, source_system, record_type);

CREATE TABLE ingest_issues (
  id               bigserial PRIMARY KEY,
  run_id           bigint    NOT NULL REFERENCES ingest_runs (id) ON DELETE CASCADE,
  source_system    text      NOT NULL,
  source_account   text      NOT NULL,
  source_file      text      NOT NULL,
  source_record_id text      NOT NULL,
  severity         text      NOT NULL CHECK (severity IN ('info', 'warn', 'error')),
  code             text      NOT NULL,
  message          text      NOT NULL
);
