-- Read views for the MCP server and the read-only role it connects as (R16, R17).
-- The views hold no homeowner names, phones or emails and no house numbers or units: a property
-- is its hundred-block, street, zip and coordinates. Tools match a caller's address through
-- address_key_hash = encode(sha256(convert_to(<normalized key>, 'UTF8')), 'hex').
-- Every row carries `sources`, a JSON array of {sourceSystem, sourceFile, sourceRecordId}
-- citations (R19), so tools answer with plain SELECTs.

CREATE VIEW v_sources AS
SELECT 'provider'::text AS entity, l.provider_id AS entity_id, l.method, l.confidence,
       sr.source_system, sr.source_account, sr.source_file, sr.source_record_id, sr.record_type,
       sr.ingested_at
  FROM provider_links l JOIN source_records sr ON sr.id = l.source_record_id
UNION ALL
SELECT 'property', l.property_id, l.method, l.confidence,
       sr.source_system, sr.source_account, sr.source_file, sr.source_record_id, sr.record_type,
       sr.ingested_at
  FROM property_links l JOIN source_records sr ON sr.id = l.source_record_id
UNION ALL
SELECT 'job', l.job_id, l.method, l.confidence,
       sr.source_system, sr.source_account, sr.source_file, sr.source_record_id, sr.record_type,
       sr.ingested_at
  FROM job_links l JOIN source_records sr ON sr.id = l.source_record_id
UNION ALL
SELECT 'calendar_block', cb.id, 'single_source', 1.00,
       sr.source_system, sr.source_account, sr.source_file, sr.source_record_id, sr.record_type,
       sr.ingested_at
  FROM calendar_blocks cb JOIN source_records sr ON sr.id = cb.source_record_id;

-- Citations per entity, ordered so output is stable. A provider cites its account and profile
-- records, not every job record linked through its account ('account_record').
CREATE VIEW v_entity_sources AS
SELECT entity, entity_id,
       array_agg(DISTINCT source_system ORDER BY source_system) AS source_systems,
       jsonb_agg(jsonb_build_object('sourceSystem', source_system, 'sourceFile', source_file,
                   'sourceRecordId', source_record_id)
                 ORDER BY source_system, source_file, source_record_id) AS sources
  FROM v_sources
 WHERE method <> 'account_record'
 GROUP BY entity, entity_id;

CREATE VIEW v_providers AS
SELECT p.id, p.display_name, p.aliases, p.trades, p.does_not_do, p.declared_service_zips,
       p.observed_service_zips, p.crew_size, p.business_phone, p.website, p.declared_crm,
       p.hours_raw, p.hours_parsed, p.confidence, s.source_systems, s.sources
  FROM providers p
  JOIN v_entity_sources s ON s.entity = 'provider' AND s.entity_id = p.id;

CREATE VIEW v_provider_conflicts AS
SELECT c.provider_id, c.kind, c.detail,
       coalesce((SELECT jsonb_agg(jsonb_build_object('sourceSystem', sr.source_system,
                   'sourceFile', sr.source_file, 'sourceRecordId', sr.source_record_id)
                   ORDER BY sr.source_system, sr.source_file, sr.source_record_id)
                   FROM source_records sr WHERE sr.id = ANY (c.source_record_ids)),
                '[]'::jsonb) AS sources
  FROM provider_conflicts c;

CREATE VIEW v_properties AS
SELECT p.id, p.block_number, p.block_label, p.street_name, p.street_type, p.zip,
       p.zip_inferred, p.city, p.in_target_zip, (p.unit IS NOT NULL) AS has_unit, p.lat, p.lon,
       p.geocode_method, p.geocode_reason,
       encode(sha256(convert_to(p.address_key, 'UTF8')), 'hex') AS address_key_hash,
       p.confidence, s.source_systems, s.sources
  FROM properties p
  JOIN v_entity_sources s ON s.entity = 'property' AND s.entity_id = p.id;

CREATE VIEW v_jobs AS
SELECT j.id, j.provider_id, pr.display_name AS provider_name, j.property_id, j.parent_job_id,
       j.kind, j.status, j.status_raw, j.trade, j.service, j.trade_method, j.trade_conflict,
       j.start_at, j.end_at, j.all_day, j.time_basis, j.completed_at, j.amount_cents,
       j.is_recurring, j.description_redacted AS description,
       j.reschedule_note_redacted AS reschedule_note, j.duplicate_count, j.confidence,
       p.block_number, p.block_label, p.street_name, p.street_type, p.zip, p.in_target_zip,
       p.lat, p.lon, encode(sha256(convert_to(p.address_key, 'UTF8')), 'hex') AS address_key_hash,
       s.source_systems, s.sources
  FROM jobs j
  JOIN providers pr ON pr.id = j.provider_id
  LEFT JOIN properties p ON p.id = j.property_id
  JOIN v_entity_sources s ON s.entity = 'job' AND s.entity_id = j.id;

CREATE VIEW v_calendar_blocks AS
SELECT cb.id, cb.provider_id, cb.start_at, cb.end_at, cb.all_day, cb.time_basis, cb.busy,
       cb.category, (cb.recurrence_uid IS NOT NULL) AS is_recurring, cb.mirrored_job_id,
       cb.mirror_confidence, s.source_systems, s.sources
  FROM calendar_blocks cb
  JOIN v_entity_sources s ON s.entity = 'calendar_block' AND s.entity_id = cb.id;

CREATE VIEW v_declared_hours AS
SELECT h.provider_id, h.weekday, to_char(h.start_local, 'HH24:MI') AS start_local,
       CASE WHEN h.end_local = '24:00'::time THEN '24:00' ELSE to_char(h.end_local, 'HH24:MI')
       END AS end_local,
       h.parsed,
       jsonb_build_array(jsonb_build_object('sourceSystem', sr.source_system,
         'sourceFile', sr.source_file, 'sourceRecordId', sr.source_record_id)) AS sources
  FROM declared_hours h JOIN source_records sr ON sr.id = h.source_record_id;

-- Everything the availability engine (src/availability/engine.ts) reads for one provider:
-- jobs, visits and estimates (work) and calendar blocks, with their status and citations.
CREATE VIEW v_availability_items AS
SELECT j.provider_id, j.id AS item_id, j.kind, j.status, j.start_at, j.end_at, j.all_day,
       true AS busy, 'work'::text AS category, j.confidence, j.source_systems, j.sources,
       j.reschedule_note
  FROM v_jobs j
UNION ALL
SELECT b.provider_id, b.id, 'calendar_block', 'confirmed', b.start_at, b.end_at, b.all_day,
       b.busy, b.category, 1.00, b.source_systems, b.sources, NULL
  FROM v_calendar_blocks b;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hsmcp_reader') THEN
    CREATE ROLE hsmcp_reader NOLOGIN;
  END IF;
END
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM hsmcp_reader;
GRANT USAGE ON SCHEMA public TO hsmcp_reader;
GRANT SELECT ON v_sources, v_entity_sources, v_providers, v_provider_conflicts, v_properties,
  v_jobs, v_calendar_blocks, v_declared_hours, v_availability_items TO hsmcp_reader;
