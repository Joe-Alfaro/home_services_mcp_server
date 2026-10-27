import type pg from 'pg'
import { createStreetIndex, type StreetIndex, type StreetSegment } from '../normalize/geocode.ts'
import { readSources, type ProviderRef, type Source } from './privacy.ts'

/*
 * Reads for the tools. Everything comes from the v_* views the hsmcp_reader role may SELECT
 * (R16); no statement here writes.
 */

export interface Provider {
  id: string
  name: string
  aliases: string[]
  trades: string[]
  doesNotDo: string[]
  declaredZips: string[] | null
  observedZips: string[]
  crewSize: number | null
  declaredCrm: string | null
  hoursParsed: string | null
  confidence: number
  sourceSystems: string[]
  sources: Source[]
}

interface ProviderRow {
  id: string
  display_name: string
  aliases: string[]
  trades: string[]
  does_not_do: string[]
  declared_service_zips: string[] | null
  observed_service_zips: string[]
  crew_size: number | null
  declared_crm: string | null
  hours_parsed: string | null
  confidence: string
  source_systems: string[]
  sources: unknown
}

function toProvider(row: ProviderRow): Provider {
  return {
    id: row.id,
    name: row.display_name,
    aliases: row.aliases,
    trades: row.trades,
    doesNotDo: row.does_not_do,
    declaredZips: row.declared_service_zips === null ? null : [...row.declared_service_zips].sort(),
    observedZips: [...row.observed_service_zips].sort(),
    crewSize: row.crew_size,
    declaredCrm: row.declared_crm,
    hoursParsed: row.hours_parsed,
    confidence: Number(row.confidence),
    sourceSystems: row.source_systems,
    sources: readSources(row.sources),
  }
}

const PROVIDER_COLUMNS = `id, display_name, aliases, trades, does_not_do, declared_service_zips,
  observed_service_zips, crew_size, declared_crm, hours_parsed, confidence, source_systems, sources`

export async function loadProviders(pool: pg.Pool): Promise<Provider[]> {
  const { rows } = await pool.query<ProviderRow>(
    `SELECT ${PROVIDER_COLUMNS} FROM v_providers ORDER BY display_name, id`,
  )
  return rows.map(toProvider)
}

export async function loadProvidersByTrade(pool: pg.Pool, trade: string): Promise<Provider[]> {
  const { rows } = await pool.query<ProviderRow>(
    `SELECT ${PROVIDER_COLUMNS} FROM v_providers WHERE $1 = ANY (trades) ORDER BY display_name, id`,
    [trade],
  )
  return rows.map(toProvider)
}

export async function loadProvider(pool: pg.Pool, id: string): Promise<Provider | undefined> {
  const { rows } = await pool.query<ProviderRow>(
    `SELECT ${PROVIDER_COLUMNS} FROM v_providers WHERE id = $1`,
    [id],
  )
  const [row] = rows
  return row === undefined ? undefined : toProvider(row)
}

export function providerRef(provider: { id: string; name: string }): ProviderRef {
  return { providerId: provider.id, name: provider.name }
}

/** A canonical job, visit or estimate with its property projected to block + zip (R17). */
export interface Job {
  id: string
  providerId: string
  providerName: string
  /** Visits of one CRM A job share it; otherwise the job's own id (Q1 counts services). */
  serviceKey: string
  /** G6: a visit's parent CRM job record(s), so a counted job cites its own id (R19). */
  parentSources: Source[]
  kind: 'job' | 'visit' | 'estimate'
  status: string
  trade: string | null
  service: string | null
  startAt: Date | null
  endAt: Date | null
  completedAt: Date | null
  allDay: boolean
  description: string | null
  duplicateCount: number
  confidence: number
  blockNumber: number | null
  blockLabel: string | null
  streetName: string | null
  streetType: string | null
  zip: string | null
  lat: number | null
  lon: number | null
  sourceSystems: string[]
  sources: Source[]
}

interface JobRow {
  id: string
  provider_id: string
  provider_name: string
  parent_job_id: string | null
  kind: Job['kind']
  status: string
  trade: string | null
  service: string | null
  start_at: Date | null
  end_at: Date | null
  completed_at: Date | null
  all_day: boolean
  description: string | null
  duplicate_count: number
  confidence: string
  block_number: number | null
  block_label: string | null
  street_name: string | null
  street_type: string | null
  zip: string | null
  lat: number | null
  lon: number | null
  source_systems: string[]
  sources: unknown
  parent_sources: unknown
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    providerId: row.provider_id,
    providerName: row.provider_name,
    serviceKey: row.parent_job_id ?? row.id,
    kind: row.kind,
    status: row.status,
    trade: row.trade,
    service: row.service,
    startAt: row.start_at,
    endAt: row.end_at,
    completedAt: row.completed_at,
    allDay: row.all_day,
    description: row.description,
    duplicateCount: row.duplicate_count,
    confidence: Number(row.confidence),
    blockNumber: row.block_number,
    blockLabel: row.block_label,
    streetName: row.street_name,
    streetType: row.street_type,
    zip: row.zip,
    lat: row.lat,
    lon: row.lon,
    sourceSystems: row.source_systems,
    sources: readSources(row.sources),
    parentSources: row.parent_sources === null ? [] : readSources(row.parent_sources),
  }
}

/**
 * G6: a CRM A job with visits is a container. Its visits carry the time, status and money and
 * point at it (serviceKey), so the tools count and show the visits, never the container. Expects
 * v_jobs aliased `j`.
 */
export const NOT_VISIT_PARENT =
  'NOT EXISTS (SELECT 1 FROM v_job_parents c WHERE c.parent_key = j.id)'

/**
 * Jobs matching a WHERE clause over v_jobs (aliased `j`), visit parents left out. Callers pass only fixed SQL plus
 * positional parameters.
 */
export async function loadJobs(
  pool: pg.Pool,
  where: string,
  params: readonly unknown[],
): Promise<Job[]> {
  const { rows } = await pool.query<JobRow>(
    `SELECT j.id, j.provider_id, j.provider_name, j.parent_job_id, j.kind, j.status, j.trade,
            j.service, j.start_at, j.end_at, j.completed_at, j.all_day, j.description,
            j.duplicate_count, j.confidence, j.block_number, j.block_label, j.street_name,
            j.street_type, j.zip, j.lat, j.lon, j.source_systems, j.sources,
            -- Correlated, not a join on v_entity_sources: that aggregates every entity (Q1 50 s).
            (SELECT jsonb_agg(jsonb_build_object('sourceSystem', s.source_system,
                      'sourceFile', s.source_file, 'sourceRecordId', s.source_record_id)
                      ORDER BY s.source_system, s.source_file, s.source_record_id)
               FROM v_sources s
              WHERE s.entity = 'job' AND s.entity_id = j.parent_job_id
                AND s.method <> 'account_record') AS parent_sources
       FROM v_jobs j
      WHERE (${where}) AND ${NOT_VISIT_PARENT}
      ORDER BY j.start_at NULLS LAST, j.id`,
    [...params],
  )
  return rows.map(toJob)
}

export interface Conflict {
  providerId: string
  kind: string
  detail: Record<string, unknown>
  sources: Source[]
}

export async function loadConflicts(pool: pg.Pool, providerIds: string[]): Promise<Conflict[]> {
  const { rows } = await pool.query<{
    provider_id: string
    kind: string
    detail: Record<string, unknown>
    sources: unknown
  }>(
    `SELECT provider_id, kind, detail, sources FROM v_provider_conflicts
      WHERE provider_id = ANY ($1) ORDER BY provider_id, kind, detail::text`,
    [providerIds],
  )
  return rows.map((row) => ({
    providerId: row.provider_id,
    kind: row.kind,
    detail: row.detail,
    sources: readSources(row.sources),
  }))
}

const streetIndexes = new WeakMap<pg.Pool, Promise<StreetIndex>>()

/** The reference street map (v_street_segments), read once per pool. */
export function loadStreetIndex(pool: pg.Pool): Promise<StreetIndex> {
  const cached = streetIndexes.get(pool)
  if (cached !== undefined) return cached
  const loading = pool
    .query<{
      street_name: string
      street_type: string
      city: string
      state: string
      zip: string
      from_number: number
      to_number: number
      start_lat: number
      start_lon: number
      end_lat: number
      end_lon: number
    }>('SELECT * FROM v_street_segments')
    .then(({ rows }) =>
      createStreetIndex(
        rows.map((row): StreetSegment => ({
          streetName: row.street_name,
          streetType: row.street_type,
          city: row.city,
          state: row.state,
          zip: row.zip,
          fromNumber: row.from_number,
          toNumber: row.to_number,
          startLat: row.start_lat,
          startLon: row.start_lon,
          endLat: row.end_lat,
          endLon: row.end_lon,
        })),
      ),
    )
  loading.catch(() => streetIndexes.delete(pool))
  streetIndexes.set(pool, loading)
  return loading
}
