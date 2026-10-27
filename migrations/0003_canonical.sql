-- Canonical model (ARCHITECTURE.md "Canonical Postgres schema", R5, R8, R11). Filled by the
-- pipeline (src/ingest/pipeline.ts) in the same transaction as source_records; every row traces
-- to source_records, and deleting an ingest run removes its canonical rows too.
-- Ids are the resolvers' stable hashed ids (prov_/prop_/job_/blk_ + 16 hex), so they are the
-- same across runs and reveal no address or account name.

CREATE TABLE street_segments (
  street_name text             NOT NULL,
  street_type text             NOT NULL,
  city        text             NOT NULL,
  state       text             NOT NULL,
  zip         text             NOT NULL,
  from_number integer          NOT NULL,
  to_number   integer          NOT NULL,
  start_lat   double precision NOT NULL,
  start_lon   double precision NOT NULL,
  end_lat     double precision NOT NULL,
  end_lon     double precision NOT NULL
);

CREATE TABLE providers (
  id                    text PRIMARY KEY,
  display_name          text    NOT NULL,
  -- Business names as given by each source, profile first. Calendar names (an owner's name,
  -- G27) are never stored here.
  aliases               text[]  NOT NULL DEFAULT '{}',
  trades                text[]  NOT NULL DEFAULT '{}',
  does_not_do           text[]  NOT NULL DEFAULT '{}',
  -- null when no source declares a service area.
  declared_service_zips text[],
  -- Zips of completed jobs and visits (G23); compare with declared_service_zips.
  observed_service_zips text[]  NOT NULL DEFAULT '{}',
  crew_size             integer,
  business_phone        text,
  website               text,
  declared_crm          text,
  hours_raw             text,
  hours_parsed          text CHECK (hours_parsed IN ('full', 'partial', 'none')),
  -- The lowest link confidence.
  confidence            numeric(3, 2) NOT NULL
);

CREATE TABLE provider_links (
  provider_id      text   NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  source_record_id bigint NOT NULL REFERENCES source_records (id) ON DELETE CASCADE,
  method           text   NOT NULL,
  confidence       numeric(3, 2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence         jsonb  NOT NULL,
  PRIMARY KEY (provider_id, source_record_id)
);

CREATE TABLE provider_conflicts (
  id                bigserial PRIMARY KEY,
  provider_id       text     NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  kind              text     NOT NULL CHECK (kind IN ('hours', 'service_area', 'trade', 'crm')),
  detail            jsonb    NOT NULL,
  source_record_ids bigint[] NOT NULL DEFAULT '{}'
);

CREATE TABLE properties (
  id             text PRIMARY KEY,
  -- Normalized number|street|type|unit|zip; an address with no number or street gets its own
  -- key so blanks never collapse (D-065).
  address_key    text    NOT NULL UNIQUE,
  house_number   text,
  street_name    text,
  street_type    text,
  unit           text,
  zip            text,
  zip_inferred   boolean NOT NULL,
  city           text,
  block_number   integer,
  block_label    text,
  lat            double precision,
  lon            double precision,
  geocode_method text    NOT NULL CHECK (geocode_method IN ('interpolated', 'none')),
  geocode_reason text,
  in_target_zip  boolean NOT NULL,
  confidence     numeric(3, 2) NOT NULL
);

CREATE INDEX properties_block_idx ON properties (street_name, block_number);

CREATE TABLE property_links (
  property_id      text   NOT NULL REFERENCES properties (id) ON DELETE CASCADE,
  source_record_id bigint NOT NULL REFERENCES source_records (id) ON DELETE CASCADE,
  -- SHA-256 of the raw address as the source gave it: evidence without the address itself.
  raw_address_hash text   NOT NULL,
  method           text   NOT NULL,
  confidence       numeric(3, 2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence         jsonb  NOT NULL,
  PRIMARY KEY (property_id, source_record_id)
);

-- Homeowner PII (R17). No reader grant, ever.
CREATE TABLE homeowner_contacts (
  property_id      text   NOT NULL REFERENCES properties (id) ON DELETE CASCADE,
  source_record_id bigint NOT NULL REFERENCES source_records (id) ON DELETE CASCADE,
  name             text,
  phones           text[] NOT NULL DEFAULT '{}',
  emails           text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE jobs (
  id                   text PRIMARY KEY,
  provider_id          text    NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  property_id          text    REFERENCES properties (id) ON DELETE CASCADE,
  -- Deferred so a visit may be loaded before its parent job.
  parent_job_id        text    REFERENCES jobs (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  kind                 text    NOT NULL CHECK (kind IN ('job', 'estimate', 'visit')),
  status               text    NOT NULL CHECK (status IN ('scheduled', 'in_progress', 'completed',
                         'cancelled', 'on_hold', 'unscheduled', 'limbo')),
  status_raw           text    NOT NULL,
  trade                text,
  service              text,
  -- How the trade was chosen and any conflict with the provider's declared trades (D-044).
  trade_method         text    NOT NULL,
  trade_conflict       jsonb,
  start_at             timestamptz,
  end_at               timestamptz,
  all_day              boolean NOT NULL,
  time_basis           text,
  completed_at         timestamptz,
  amount_cents         bigint,
  is_recurring         boolean NOT NULL,
  description_redacted text,
  reschedule_note_redacted text,
  duplicate_count      integer NOT NULL,
  confidence           numeric(3, 2) NOT NULL
);

CREATE INDEX jobs_provider_idx ON jobs (provider_id, start_at);
CREATE INDEX jobs_property_idx ON jobs (property_id);

CREATE TABLE job_links (
  job_id           text   NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  source_record_id bigint NOT NULL REFERENCES source_records (id) ON DELETE CASCADE,
  method           text   NOT NULL,
  confidence       numeric(3, 2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence         jsonb  NOT NULL,
  PRIMARY KEY (job_id, source_record_id)
);

CREATE TABLE declared_hours (
  provider_id      text     NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  -- ISO weekday: 1 = Monday … 7 = Sunday.
  weekday          smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_local      time     NOT NULL,
  -- 24:00 for windows that run to midnight.
  end_local        time     NOT NULL,
  source_record_id bigint   NOT NULL REFERENCES source_records (id) ON DELETE CASCADE,
  parsed           text     NOT NULL CHECK (parsed IN ('full', 'partial', 'none'))
);

CREATE TABLE calendar_blocks (
  id                text PRIMARY KEY,
  provider_id       text    NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  start_at          timestamptz NOT NULL,
  end_at            timestamptz NOT NULL,
  all_day           boolean NOT NULL,
  time_basis        text    NOT NULL,
  busy              boolean NOT NULL,
  category          text    NOT NULL CHECK (category IN ('work', 'personal', 'unknown')),
  recurrence_uid    text,
  -- The job this block mirrors (D-047), if any.
  mirrored_job_id   text    REFERENCES jobs (id) ON DELETE SET NULL,
  mirror_confidence numeric(3, 2),
  source_record_id  bigint  NOT NULL REFERENCES source_records (id) ON DELETE CASCADE
);

CREATE INDEX calendar_blocks_provider_idx ON calendar_blocks (provider_id, start_at);

CREATE TABLE match_decisions (
  id          bigserial PRIMARY KEY,
  entity      text  NOT NULL CHECK (entity IN ('provider', 'property', 'job')),
  -- "sourceSystem:sourceAccount:sourceRecordId" of each side.
  left_ref    text  NOT NULL,
  right_ref   text  NOT NULL,
  method      text  NOT NULL,
  score       numeric(3, 2) NOT NULL,
  decision    text  NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  evidence    jsonb NOT NULL
);
