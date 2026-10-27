import type pg from 'pg'
import type { StreetSegment } from '../normalize/geocode.ts'
import type { CanonicalModel, RecordKey } from '../ingest/canonical.ts'
import { insertInChunks } from './ingest.ts'

/** Every table the pipeline replaces on each run, children first. */
export const CANONICAL_TABLES = [
  'match_decisions',
  'calendar_blocks',
  'declared_hours',
  'job_links',
  'jobs',
  'homeowner_contacts',
  'property_links',
  'properties',
  'provider_conflicts',
  'provider_links',
  'providers',
  'street_segments',
] as const

/** Empties the canonical tables; the caller then deletes the ingest runs they came from. */
export async function clearCanonical(client: pg.Client): Promise<void> {
  await client.query(`TRUNCATE ${CANONICAL_TABLES.join(', ')}`)
}

export async function writeStreetSegments(
  client: pg.Client,
  segments: readonly StreetSegment[],
): Promise<void> {
  await insertInChunks(
    client,
    `INSERT INTO street_segments (street_name, street_type, city, state, zip, from_number,
       to_number, start_lat, start_lon, end_lat, end_lon)
     SELECT "streetName", "streetType", city, state, zip, "fromNumber", "toNumber", "startLat",
       "startLon", "endLat", "endLon"
     FROM jsonb_to_recordset($1::jsonb) AS r("streetName" text, "streetType" text, city text,
       state text, zip text, "fromNumber" integer, "toNumber" integer,
       "startLat" double precision, "startLon" double precision, "endLat" double precision,
       "endLon" double precision)`,
    segments,
  )
}

async function sourceRecordIds(client: pg.Client, runId: number): Promise<Map<RecordKey, number>> {
  const { rows } = await client.query<{ id: string; key: string }>(
    `SELECT id, concat_ws('|', source_system, source_file, source_record_id, record_type) AS key
       FROM source_records WHERE run_id = $1`,
    [runId],
  )
  return new Map(rows.map((row) => [row.key, Number(row.id)]))
}

/**
 * Loads the canonical model of one run (R5, R8, R11). Runs inside the caller's transaction,
 * after the run's source records are inserted.
 */
export async function writeCanonical(
  client: pg.Client,
  runId: number,
  model: CanonicalModel,
): Promise<void> {
  const ids = await sourceRecordIds(client, runId)
  function idOf(record: RecordKey): number {
    const id = ids.get(record)
    if (id === undefined) throw new Error(`No source record for ${record.split('|')[0] ?? ''}`)
    return id
  }
  const links = (rows: readonly { record: RecordKey }[]) =>
    rows.map((row) => ({ ...row, srid: idOf(row.record) }))

  await insertInChunks(
    client,
    `INSERT INTO providers (id, display_name, aliases, trades, does_not_do,
       declared_service_zips, observed_service_zips, crew_size, business_phone, website,
       declared_crm, hours_raw, hours_parsed, confidence)
     SELECT id, "displayName", aliases, trades, "doesNotDo", "declaredServiceZips",
       "observedServiceZips", "crewSize", "businessPhone", website, "declaredCrm", "hoursRaw",
       "hoursParsed", confidence
     FROM jsonb_to_recordset($1::jsonb) AS r(id text, "displayName" text, aliases text[],
       trades text[], "doesNotDo" text[], "declaredServiceZips" text[],
       "observedServiceZips" text[], "crewSize" integer, "businessPhone" text, website text,
       "declaredCrm" text, "hoursRaw" text, "hoursParsed" text, confidence numeric)`,
    model.providers,
  )
  await insertInChunks(
    client,
    `INSERT INTO provider_links (provider_id, source_record_id, method, confidence, evidence)
     SELECT "entityId", srid, method, confidence, evidence
     FROM jsonb_to_recordset($1::jsonb) AS r("entityId" text, srid bigint, method text,
       confidence numeric, evidence jsonb)`,
    links(model.providerLinks),
  )
  await insertInChunks(
    client,
    `INSERT INTO provider_conflicts (provider_id, kind, detail, source_record_ids)
     SELECT "providerId", kind, detail, srids
     FROM jsonb_to_recordset($1::jsonb) AS r("providerId" text, kind text, detail jsonb,
       srids bigint[])`,
    model.providerConflicts.map(({ records, ...row }) => ({
      ...row,
      srids: [...new Set(records.map(idOf))],
    })),
  )
  await insertInChunks(
    client,
    `INSERT INTO properties (id, address_key, house_number, street_name, street_type, unit, zip,
       zip_inferred, city, block_number, block_label, lat, lon, geocode_method, geocode_reason,
       in_target_zip, confidence)
     SELECT id, "addressKey", "houseNumber", "streetName", "streetType", unit, zip,
       "zipInferred", city, "blockNumber", "blockLabel", lat, lon, "geocodeMethod",
       "geocodeReason", "inTargetZip", confidence
     FROM jsonb_to_recordset($1::jsonb) AS r(id text, "addressKey" text, "houseNumber" text,
       "streetName" text, "streetType" text, unit text, zip text, "zipInferred" boolean,
       city text, "blockNumber" integer, "blockLabel" text, lat double precision,
       lon double precision, "geocodeMethod" text, "geocodeReason" text,
       "inTargetZip" boolean, confidence numeric)`,
    model.properties,
  )
  await insertInChunks(
    client,
    `INSERT INTO property_links (property_id, source_record_id, raw_address_hash, method,
       confidence, evidence)
     SELECT "entityId", srid, "rawAddressHash", method, confidence, evidence
     FROM jsonb_to_recordset($1::jsonb) AS r("entityId" text, srid bigint,
       "rawAddressHash" text, method text, confidence numeric, evidence jsonb)`,
    links(model.propertyLinks),
  )
  await insertInChunks(
    client,
    `INSERT INTO homeowner_contacts (property_id, source_record_id, name, phones, emails)
     SELECT "propertyId", srid, name, phones, emails
     FROM jsonb_to_recordset($1::jsonb) AS r("propertyId" text, srid bigint, name text,
       phones text[], emails text[])`,
    links(model.contacts),
  )
  await insertInChunks(
    client,
    `INSERT INTO jobs (id, provider_id, property_id, parent_job_id, kind, status, status_raw,
       trade, service, trade_method, trade_conflict, start_at, end_at, all_day, time_basis,
       completed_at, amount_cents, is_recurring, description_redacted,
       reschedule_note_redacted, duplicate_count, confidence)
     SELECT id, "providerId", "propertyId", "parentJobId", kind, status, "statusRaw", trade,
       service, "tradeMethod", "tradeConflict", "startAt", "endAt", "allDay", "timeBasis",
       "completedAt", "amountCents", "isRecurring", "descriptionRedacted",
       "rescheduleNoteRedacted", "duplicateCount", confidence
     FROM jsonb_to_recordset($1::jsonb) AS r(id text, "providerId" text, "propertyId" text,
       "parentJobId" text, kind text, status text, "statusRaw" text, trade text, service text,
       "tradeMethod" text, "tradeConflict" jsonb, "startAt" timestamptz, "endAt" timestamptz,
       "allDay" boolean, "timeBasis" text, "completedAt" timestamptz, "amountCents" bigint,
       "isRecurring" boolean, "descriptionRedacted" text, "rescheduleNoteRedacted" text,
       "duplicateCount" integer, confidence numeric)`,
    model.jobs,
  )
  await insertInChunks(
    client,
    `INSERT INTO job_links (job_id, source_record_id, method, confidence, evidence)
     SELECT "entityId", srid, method, confidence, evidence
     FROM jsonb_to_recordset($1::jsonb) AS r("entityId" text, srid bigint, method text,
       confidence numeric, evidence jsonb)`,
    links(model.jobLinks),
  )
  await insertInChunks(
    client,
    `INSERT INTO declared_hours (provider_id, weekday, start_local, end_local,
       source_record_id, parsed)
     SELECT "providerId", weekday, "startLocal"::time, "endLocal"::time, srid, parsed
     FROM jsonb_to_recordset($1::jsonb) AS r("providerId" text, weekday smallint,
       "startLocal" text, "endLocal" text, srid bigint, parsed text)`,
    links(model.declaredHours),
  )
  await insertInChunks(
    client,
    `INSERT INTO calendar_blocks (id, provider_id, start_at, end_at, all_day, time_basis, busy,
       category, recurrence_uid, mirrored_job_id, mirror_confidence, source_record_id)
     SELECT id, "providerId", "startAt", "endAt", "allDay", "timeBasis", busy, category,
       "recurrenceUid", "mirroredJobId", "mirrorConfidence", srid
     FROM jsonb_to_recordset($1::jsonb) AS r(id text, "providerId" text,
       "startAt" timestamptz, "endAt" timestamptz, "allDay" boolean, "timeBasis" text,
       busy boolean, category text, "recurrenceUid" text, "mirroredJobId" text,
       "mirrorConfidence" numeric, srid bigint)`,
    links(model.calendarBlocks),
  )
  await insertInChunks(
    client,
    `INSERT INTO match_decisions (entity, left_ref, right_ref, method, score, decision, evidence)
     SELECT entity, "leftRef", "rightRef", method, score, decision, evidence
     FROM jsonb_to_recordset($1::jsonb) AS r(entity text, "leftRef" text, "rightRef" text,
       method text, score numeric, decision text, evidence jsonb)`,
    model.matchDecisions,
  )
}
