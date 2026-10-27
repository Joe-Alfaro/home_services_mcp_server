-- Facts the adapters already compute, persisted so the read views and tools can use them (D-119):
-- G9 the local date a job was rescheduled from (its old slot never blocks), G17 a calendar
-- event's ICS status (a tentative hold blocks at low confidence), and G20 a 24/7 hours claim
-- (openings then come from observed hours at low confidence).
ALTER TABLE jobs ADD COLUMN rescheduled_from date;
ALTER TABLE calendar_blocks ADD COLUMN status text NOT NULL DEFAULT 'confirmed'
  CHECK (status IN ('confirmed', 'tentative', 'cancelled'));
ALTER TABLE declared_hours ADD COLUMN always_open boolean NOT NULL DEFAULT false;

-- New columns go last so CREATE OR REPLACE keeps each view's existing columns.
CREATE OR REPLACE VIEW v_jobs AS
SELECT j.id, j.provider_id, pr.display_name AS provider_name, j.property_id, j.parent_job_id,
       j.kind, j.status, j.status_raw, j.trade, j.service, j.trade_method, j.trade_conflict,
       j.start_at, j.end_at, j.all_day, j.time_basis, j.completed_at, j.amount_cents,
       j.is_recurring, j.description_redacted AS description,
       j.reschedule_note_redacted AS reschedule_note, j.duplicate_count, j.confidence,
       p.block_number, p.block_label, p.street_name, p.street_type, p.zip, p.in_target_zip,
       p.lat, p.lon, encode(sha256(convert_to(p.address_key, 'UTF8')), 'hex') AS address_key_hash,
       s.source_systems, s.sources, j.rescheduled_from
  FROM jobs j
  JOIN providers pr ON pr.id = j.provider_id
  LEFT JOIN properties p ON p.id = j.property_id
  JOIN v_entity_sources s ON s.entity = 'job' AND s.entity_id = j.id;

CREATE OR REPLACE VIEW v_calendar_blocks AS
SELECT cb.id, cb.provider_id, cb.start_at, cb.end_at, cb.all_day, cb.time_basis, cb.busy,
       cb.category, (cb.recurrence_uid IS NOT NULL) AS is_recurring, cb.mirrored_job_id,
       cb.mirror_confidence, s.source_systems, s.sources, cb.status
  FROM calendar_blocks cb
  JOIN v_entity_sources s ON s.entity = 'calendar_block' AND s.entity_id = cb.id;

CREATE OR REPLACE VIEW v_declared_hours AS
SELECT h.provider_id, h.weekday, to_char(h.start_local, 'HH24:MI') AS start_local,
       CASE WHEN h.end_local = '24:00'::time THEN '24:00' ELSE to_char(h.end_local, 'HH24:MI')
       END AS end_local,
       h.parsed,
       jsonb_build_array(jsonb_build_object('sourceSystem', sr.source_system,
         'sourceFile', sr.source_file, 'sourceRecordId', sr.source_record_id)) AS sources,
       h.always_open
  FROM declared_hours h JOIN source_records sr ON sr.id = h.source_record_id;

-- A calendar block now carries its own status (it was always 'confirmed' here).
CREATE OR REPLACE VIEW v_availability_items AS
SELECT j.provider_id, j.id AS item_id, j.kind, j.status, j.start_at, j.end_at, j.all_day,
       true AS busy, 'work'::text AS category, j.confidence, j.source_systems, j.sources,
       j.reschedule_note
  FROM v_jobs j
UNION ALL
SELECT b.provider_id, b.id, 'calendar_block', b.status, b.start_at, b.end_at, b.all_day,
       b.busy, b.category, 1.00, b.source_systems, b.sources, NULL
  FROM v_calendar_blocks b;
