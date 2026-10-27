import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  loadPipeline,
  readPackFile,
  runPackPipeline,
  SOURCE_SYSTEMS,
  startPostgres,
  type PipelineResult,
} from './support/pack.ts'

/*
 * M1b: the full ingest over the invented fixture pack in test/fixtures/pack (mirrors the data
 * pack layout). Entry point and conventions are pinned in ./support/pack.ts. Expected facts below
 * were worked out by hand from the fixture files:
 *
 * - 7 canonical providers. Pecan Valley Plumbing = CRM C account + CRM B account + profile, one
 *   phone in three formats (G13); Pecan Valley Pest Control stays separate. Bluestem Fix-It (old
 *   name) + Lakeside Handyman (new name) + profile share one phone (G14). Larkspur Handyman =
 *   CSV log + profile (same name) + its ICS calendar (file stem and owner name match the
 *   profile; the calendar has no phone). Mockingbird, Sumac Creek and Bishop Arts each = one
 *   CRM account + profile.
 * - 20 canonical properties. 5823 Belmont Ave 75206 appears under five spellings in four
 *   sources (CRM A, CRM B, both CRM C accounts, zip-less CSV) and is one home; 5823 Belmont Ave
 *   Apt B and 5823 Juniper Ave are other homes (G24, G28); 915 Glade Dr, Garland 75041 is out
 *   of area (geocode_method 'none').
 * - The approved CRM B estimate est-pv-01 folds into job job-pv-01 (G5), so 2 estimate rows
 *   remain; the two pairs of identical CSV rows each collapse to one job with
 *   duplicate_count = 2 (G16).
 */

const CANONICAL_TABLES = [
  'ingest_runs',
  'source_records',
  'street_segments',
  'providers',
  'provider_links',
  'provider_conflicts',
  'properties',
  'property_links',
  'homeowner_contacts',
  'jobs',
  'job_links',
  'declared_hours',
  'calendar_blocks',
  'match_decisions',
]

const READ_VIEWS = [
  'v_providers',
  'v_properties',
  'v_jobs',
  'v_calendar_blocks',
  'v_declared_hours',
  'v_sources',
]

const COUNTED_TABLES = CANONICAL_TABLES.filter((table) => table !== 'ingest_runs')

const CANONICAL_STATUSES = [
  'scheduled',
  'in_progress',
  'completed',
  'cancelled',
  'on_hold',
  'unscheduled',
  'limbo',
]

describe('pipeline over the fixture pack (M1b)', () => {
  let container: StartedPostgreSqlContainer
  let client: pg.Client
  let first: PipelineResult

  async function rows<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) {
    return (await client.query<T>(sql, params)).rows
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const [row] = await rows<{ n: string }>(sql, params)
    return Number(row?.n)
  }

  async function tableCounts(): Promise<Record<string, number>> {
    const entries = await Promise.all(
      COUNTED_TABLES.map(
        async (table) => [table, await count(`SELECT count(*) AS n FROM ${table}`)] as const,
      ),
    )
    return Object.fromEntries(entries)
  }

  /** Canonical provider ids linked to source records of one file. */
  async function providersOfFile(sourceFile: string): Promise<string[]> {
    const found = await rows<{ provider_id: string }>(
      `SELECT DISTINCT pl.provider_id::text AS provider_id
         FROM provider_links pl JOIN source_records sr ON sr.id = pl.source_record_id
        WHERE sr.source_file = $1`,
      [sourceFile],
    )
    return found.map((row) => row.provider_id)
  }

  async function providerOfFile(sourceFile: string): Promise<string> {
    const ids = await providersOfFile(sourceFile)
    expect(ids, `providers linked to ${sourceFile}`).toHaveLength(1)
    return ids[0] ?? ''
  }

  beforeAll(async () => {
    container = await startPostgres()
    client = new pg.Client({ connectionString: container.getConnectionUri() })
    await client.connect()
    first = await runPackPipeline(await loadPipeline(), container.getConnectionUri())
  })

  afterAll(async () => {
    await client.end()
    await container.stop()
  })

  describe('schema (R5)', () => {
    it('creates every canonical table and read view in ARCHITECTURE.md', async () => {
      const found = await rows<{ name: string }>(
        `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'`,
      )
      const names = found.map((row) => row.name)
      expect(names).toEqual(expect.arrayContaining([...CANONICAL_TABLES, ...READ_VIEWS]))
    })

    it('has no column named after one source system (R5 b)', async () => {
      const columns = await rows<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [[...CANONICAL_TABLES, ...READ_VIEWS]],
      )
      const sourceNamed = columns.filter(({ column_name: column }) =>
        /(^|_)(jobber|hcp|housecall|housecallpro|workiz|gsheet|ical)(_|$)|^(csv|ics)_/i.test(
          column,
        ),
      )
      expect(sourceNamed).toEqual([])
    })
  })

  describe('ingest summary (R1, R9)', () => {
    it('reports records, no error issues and no unmapped statuses', () => {
      expect(first.summary.totals.records).toBeGreaterThan(0)
      expect(first.summary.totals.errors).toBe(0)
      expect(first.summary.totals.unmappedStatuses).toBe(0)
    })

    it('stores records from exactly the six source systems (R1 b)', async () => {
      const found = await rows<{ source_system: string }>(
        'SELECT DISTINCT source_system FROM source_records ORDER BY source_system',
      )
      expect(found.map((row) => row.source_system)).toEqual([...SOURCE_SYSTEMS])
    })

    it('reads every CRM B page and drops the job repeated across a page boundary (R1 d, G3)', async () => {
      const perCompany = await rows<{ account: string; n: string }>(
        `SELECT source_account AS account, count(DISTINCT source_record_id) AS n
           FROM source_records
          WHERE source_system = 'housecall_pro' AND source_file LIKE '%/jobs_page_%'
          GROUP BY source_account ORDER BY source_account`,
      )
      expect(perCompany.map((row) => [row.account, Number(row.n)])).toEqual([
        ['pecan_valley_plumbing_co', 3],
        ['sumac_creek_rooter', 2],
      ])
    })

    it('maps every job to a canonical status', async () => {
      const statuses = await rows<{ status: string }>('SELECT DISTINCT status FROM jobs')
      expect(statuses.length).toBeGreaterThan(0)
      statuses.forEach(({ status }) => {
        expect(CANONICAL_STATUSES).toContain(status)
      })
    })
  })

  describe('provenance (R11)', () => {
    it('has non-null provenance on every source record (R11 b)', async () => {
      expect(
        await count(
          `SELECT count(*) AS n FROM source_records
            WHERE source_system IS NULL OR source_file IS NULL OR source_record_id IS NULL
               OR ingested_at IS NULL`,
        ),
      ).toBe(0)
    })

    it.each([
      ['providers', 'provider_links', 'provider_id'],
      ['properties', 'property_links', 'property_id'],
      ['jobs', 'job_links', 'job_id'],
    ])('joins every %s row to at least one source record (R11 a)', async (table, links, key) => {
      expect(await count(`SELECT count(*) AS n FROM ${table}`)).toBeGreaterThan(0)
      const orphans = await count(
        `SELECT count(*) AS n FROM ${table} t
          WHERE NOT EXISTS (
            SELECT 1 FROM ${links} l JOIN source_records sr ON sr.id = l.source_record_id
             WHERE l.${key} = t.id)`,
      )
      expect(orphans).toBe(0)
    })

    it('joins every calendar block to its source record (R11 a)', async () => {
      expect(await count('SELECT count(*) AS n FROM calendar_blocks')).toBeGreaterThan(0)
      expect(
        await count(
          `SELECT count(*) AS n FROM calendar_blocks cb
            WHERE NOT EXISTS (SELECT 1 FROM source_records sr WHERE sr.id = cb.source_record_id)`,
        ),
      ).toBe(0)
    })

    it('round-trips one job to its file and record ID (R11 c)', async () => {
      const found = await rows<{ source_file: string; source_record_id: string }>(
        `SELECT sr.source_file, sr.source_record_id
           FROM jobs j
           JOIN job_links jl ON jl.job_id = j.id
           JOIN source_records sr ON sr.id = jl.source_record_id
          WHERE sr.source_system = 'workiz' AND sr.source_record_id = 'PV5823A'`,
      )
      expect(found).toEqual([
        {
          source_file: 'sources/workiz/pecan_valley_plumbing/jobs.json',
          source_record_id: 'PV5823A',
        },
      ])
      expect(readPackFile('sources/workiz/pecan_valley_plumbing/jobs.json')).toContain(
        '"UUID": "PV5823A"',
      )
    })
  })

  describe('match links (R8)', () => {
    it.each(['provider_links', 'property_links', 'job_links'])(
      'gives every %s row a confidence in [0, 1], a method and evidence',
      async (links) => {
        expect(await count(`SELECT count(*) AS n FROM ${links}`)).toBeGreaterThan(0)
        const bad = await count(
          `SELECT count(*) AS n FROM ${links}
            WHERE confidence IS NULL OR confidence < 0 OR confidence > 1
               OR method IS NULL OR method = '' OR evidence IS NULL`,
        )
        expect(bad).toBe(0)
      },
    )
  })

  describe('provider dedupe (R6, G13, G14)', () => {
    it('resolves the pack to 7 canonical providers', async () => {
      expect(await count('SELECT count(*) AS n FROM providers')).toBe(7)
    })

    it('links both CRM accounts and the profile of the business that moved CRMs (G13)', async () => {
      const id = await providerOfFile('sources/workiz/pecan_valley_plumbing/jobs.json')
      expect(await providerOfFile('sources/workiz/pecan_valley_plumbing/account.json')).toBe(id)
      expect(
        await providerOfFile('sources/housecall_pro/pecan_valley_plumbing_co/company.json'),
      ).toBe(id)
      const profileLinks = await rows<{ method: string; confidence: string }>(
        `SELECT pl.method, pl.confidence::text AS confidence
           FROM provider_links pl JOIN source_records sr ON sr.id = pl.source_record_id
          WHERE pl.provider_id::text = $1 AND sr.source_system = 'profiles'
            AND sr.source_record_id = 'pf_101' AND sr.record_type = 'provider'`,
        [id],
      )
      expect(profileLinks).toHaveLength(1)
      expect(profileLinks[0]?.method).toMatch(/phone/)
      expect(Number(profileLinks[0]?.confidence)).toBeCloseTo(0.95, 2)
    })

    it('keeps the "Pecan Valley" pest business apart from the plumber (G13)', async () => {
      const plumber = await providerOfFile('sources/workiz/pecan_valley_plumbing/account.json')
      const pest = await providerOfFile('sources/jobber/pecan_valley_pest.json')
      expect(pest).not.toBe(plumber)
    })

    it('merges the rebranded handyman accounts that share one phone (G14)', async () => {
      const oldName = await providerOfFile('sources/jobber/bluestem_fix_it.json')
      expect(await providerOfFile('sources/jobber/lakeside_handyman.json')).toBe(oldName)
    })

    it('links the CSV log and the calendar of one handyman to the same provider', async () => {
      const fromLog = await providerOfFile('sources/spreadsheet/larkspur_handyman_job_log.csv')
      const calendarProviders = await rows<{ provider_id: string }>(
        `SELECT DISTINCT cb.provider_id::text AS provider_id
           FROM calendar_blocks cb JOIN source_records sr ON sr.id = cb.source_record_id
          WHERE sr.source_file = 'sources/calendars/larkspur_handyman_google_calendar.ics'`,
      )
      expect(calendarProviders).toEqual([{ provider_id: fromLog }])
    })

    it('records the 75214 work the plumber does not declare as a service-area conflict (G23)', async () => {
      const id = await providerOfFile('sources/workiz/pecan_valley_plumbing/account.json')
      const conflicts = await rows<{ kind: string; detail: unknown }>(
        'SELECT kind, detail FROM provider_conflicts WHERE provider_id::text = $1',
        [id],
      )
      const serviceArea = conflicts.filter((conflict) => conflict.kind === 'service_area')
      expect(JSON.stringify(serviceArea)).toContain('75214')
    })

    it('records the pest visits booked outside its declared hours as an hours conflict (G23)', async () => {
      // Declared "Mon-Sat 8am-6pm"; visit-pvpest-04 is Sun 11-15 23:30 and visit-pvpest-05 is
      // Mon 11-16 00:30 local. The cancelled visit-pvpest-03 (Wed 09:00) is inside the hours.
      const id = await providerOfFile('sources/jobber/pecan_valley_pest.json')
      const conflicts = await rows<{ detail: unknown; sources: Array<{ sourceRecordId: string }> }>(
        `SELECT detail, sources FROM v_provider_conflicts
          WHERE provider_id::text = $1 AND kind = 'hours'`,
        [id],
      )
      expect(conflicts).toHaveLength(1)
      const [conflict] = conflicts
      expect(JSON.stringify(conflict?.detail)).toContain('Mon-Sat 8am-6pm')
      const cited = (conflict?.sources ?? []).map((source) => source.sourceRecordId)
      expect(cited).toEqual(expect.arrayContaining(['visit-pvpest-04', 'visit-pvpest-05']))
      expect(cited).not.toContain('visit-pvpest-03')
    })
  })

  describe('property dedupe and geocoding (R7, G19, G22, G24, G28)', () => {
    it('resolves the pack to 20 canonical properties', async () => {
      expect(await count('SELECT count(*) AS n FROM properties')).toBe(20)
    })

    it('merges five spellings of 5823 Belmont Ave across four sources into one home', async () => {
      const homes = await rows<{ property_id: string; source_system: string }>(
        `SELECT DISTINCT p.id::text AS property_id, sr.source_system
           FROM properties p
           JOIN property_links pl ON pl.property_id = p.id
           JOIN source_records sr ON sr.id = pl.source_record_id
          WHERE p.house_number = '5823' AND p.zip = '75206' AND p.street_name ILIKE 'belmont'
            AND (p.unit IS NULL OR p.unit = '')`,
      )
      expect(new Set(homes.map((home) => home.property_id)).size).toBe(1)
      expect(new Set(homes.map((home) => home.source_system))).toEqual(
        new Set(['jobber', 'housecall_pro', 'workiz', 'spreadsheet']),
      )
    })

    it('keeps the unit and the same number on another street as separate homes (G24, G28)', async () => {
      const ids = await rows<{ id: string }>(
        `SELECT id::text AS id FROM properties WHERE house_number = '5823' AND zip = '75206'`,
      )
      expect(ids).toHaveLength(3)
    })

    it('interpolates target-area homes and keeps the out-of-area home with no geocode', async () => {
      const [inArea] = await rows<{ lat: number; lon: number; geocode_method: string }>(
        `SELECT lat::float8 AS lat, lon::float8 AS lon, geocode_method FROM properties
          WHERE house_number = '4790' AND street_name ILIKE 'live oak'`,
      )
      expect(inArea?.geocode_method).toBe('interpolated')
      expect(inArea?.lat).toBeCloseTo(32.801, 5)
      expect(inArea?.lon).toBeCloseTo(-96.77775, 4)

      const outOfArea = await rows<{ geocode_method: string; lat: number | null }>(
        `SELECT geocode_method, lat::float8 AS lat FROM properties WHERE zip = '75041'`,
      )
      expect(outOfArea).toEqual([{ geocode_method: 'none', lat: null }])
    })

    it('labels a home with its hundred-block', async () => {
      const labels = await rows<{ block_label: string }>(
        `SELECT DISTINCT block_label FROM properties
          WHERE house_number IN ('4518', '4533', '4541', '4588') AND zip = '75204'`,
      )
      expect(labels).toEqual([{ block_label: '4500 block of Live Oak St' }])
    })
  })

  describe('job dedupe (G5, G16)', () => {
    it('collapses each pair of identical CSV rows into one job with duplicate_count 2', async () => {
      const csvJobs = await rows<{ duplicate_count: number | string }>(
        `SELECT DISTINCT j.id, j.duplicate_count
           FROM jobs j
           JOIN job_links jl ON jl.job_id = j.id
           JOIN source_records sr ON sr.id = jl.source_record_id
          WHERE sr.source_system = 'spreadsheet'`,
      )
      expect(csvJobs).toHaveLength(4)
      expect(csvJobs.filter((job) => Number(job.duplicate_count) === 2)).toHaveLength(2)
    })

    it('folds the approved estimate into the job created from it', async () => {
      const links = await rows<{ source_record_id: string }>(
        `SELECT sr.source_record_id
           FROM job_links jl JOIN source_records sr ON sr.id = jl.source_record_id
          WHERE jl.job_id = (
            SELECT jl2.job_id FROM job_links jl2
              JOIN source_records sr2 ON sr2.id = jl2.source_record_id
             WHERE sr2.source_system = 'housecall_pro' AND sr2.source_record_id = 'job-pv-01')`,
      )
      expect(links.map((link) => link.source_record_id).sort()).toEqual(['est-pv-01', 'job-pv-01'])
      expect(await count(`SELECT count(*) AS n FROM jobs WHERE kind = 'estimate'`)).toBe(2)
    })
  })

  describe('CRM A visits under one parent job (G6)', () => {
    /** Canonical rows of the recurring pest job's five visits, with their parent. */
    async function pestVisits() {
      return rows<{ id: string; kind: string; parent_job_id: string | null }>(
        `SELECT DISTINCT j.id::text AS id, j.kind, j.parent_job_id::text AS parent_job_id
           FROM jobs j
           JOIN job_links jl ON jl.job_id = j.id
           JOIN source_records sr ON sr.id = jl.source_record_id
          WHERE sr.source_system = 'jobber' AND sr.source_record_id LIKE 'visit-pvpest-%'`,
      )
    }

    it('links all five visits of the recurring job to one canonical parent job', async () => {
      const visits = await pestVisits()
      expect(visits).toHaveLength(5)
      visits.forEach((visit) => {
        expect(visit.kind).toBe('visit')
      })
      const parents = new Set(visits.map((visit) => visit.parent_job_id))
      expect(parents.size).toBe(1)
      const [parentId] = [...parents]
      expect(parentId).not.toBeNull()

      const parent = await rows<{ kind: string; parent_job_id: string | null }>(
        'SELECT kind, parent_job_id::text AS parent_job_id FROM jobs WHERE id::text = $1',
        [parentId],
      )
      expect(parent).toEqual([{ kind: 'job', parent_job_id: null }])
    })

    it('traces the parent job to its own CRM A record (R11)', async () => {
      const [visit] = await pestVisits()
      const cited = await rows<{ source_record_id: string }>(
        `SELECT sr.source_record_id
           FROM job_links jl JOIN source_records sr ON sr.id = jl.source_record_id
          WHERE jl.job_id::text = $1`,
        [visit?.parent_job_id ?? ''],
      )
      expect(cited.map((row) => row.source_record_id)).toContain('job-pvpest-01')
    })

    it('counts the job with two completed visits once in Q1-style history', async () => {
      const id = await providerOfFile('sources/jobber/pecan_valley_pest.json')
      const services = await count(
        `SELECT count(DISTINCT coalesce(parent_job_id, id)) AS n FROM jobs
          WHERE provider_id::text = $1 AND status = 'completed' AND kind <> 'estimate'`,
        [id],
      )
      expect(services).toBe(1)
    })
  })

  describe('re-running (R22 b)', () => {
    it('leaves the same row counts', async () => {
      const before = await tableCounts()
      const second = await runPackPipeline(await loadPipeline(), container.getConnectionUri())
      expect(second.summary.totals).toEqual(first.summary.totals)
      expect(await tableCounts()).toEqual(before)
      expect(await count('SELECT count(*) AS n FROM ingest_runs')).toBe(1)
    })
  })
})
