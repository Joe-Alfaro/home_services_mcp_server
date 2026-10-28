/*
 * R2: "a new source can be added without touching core logic". A seventh adapter, written only
 * against the SourceAdapter contract and appended to the registered list, flows through the same
 * core steps the pipeline runs (claim files, run adapters, summarize, build the canonical model):
 * its files are claimed, it gets a summary row, its provider merges with a matching profile, and
 * its jobs and home land in the canonical rows with provenance.
 *
 * The new system name is not in the SourceSystem union; adding a real source would extend that
 * type in src/adapters/types.ts, which is part of the adapter contract, not core logic.
 *
 * All names, phones and addresses are invented; phones use the 555-01xx fictional range.
 */
import { describe, expect, it } from 'vitest'
import { adapters } from '../../../src/adapters/registry.ts'
import type {
  CandidateBatch,
  SourceAdapter,
  SourceFile,
  SourceSystem,
} from '../../../src/adapters/types.ts'
import { buildCanonical, recordKeyOf } from '../../../src/ingest/canonical.ts'
import { claimedBy } from '../../../src/ingest/files.ts'
import { runAdapters, summarize } from '../../../src/ingest/run.ts'
import { makeCtx } from '../adapters/support.ts'
import { referenceIndex, structured } from '../normalize/reference.ts'
import { job, property, provider } from '../resolve/support.ts'

const NEW_SYSTEM = 'fieldbook' as string as SourceSystem
const ACCOUNT = 'harrow_plumbing'
const NEW_FILE = `sources/fieldbook/${ACCOUNT}.json`
const PROFILES_FILE = 'sources/profiles/providers.json'
const PHONE = '214-555-0142'

interface FieldbookExport {
  account: string
  business: string
  phone: string
  jobs: { id: string; home: string; start: string; end: string; status: string }[]
}

const EXPORT: FieldbookExport = {
  account: ACCOUNT,
  business: 'Harrow Plumbing Co',
  phone: PHONE,
  jobs: [
    {
      id: 'fb-1',
      home: '4512 Wicker Ln',
      start: '2026-10-20T15:00:00Z',
      end: '2026-10-20T17:00:00Z',
      status: 'done',
    },
    {
      id: 'fb-2',
      home: '4512 Wicker Ln',
      start: '2026-11-03T15:00:00Z',
      end: '2026-11-03T17:00:00Z',
      status: 'booked',
    },
  ],
}

function emptyBatch(): CandidateBatch {
  return {
    providers: [],
    properties: [],
    jobs: [],
    calendarBlocks: [],
    declaredHours: [],
    issues: [],
  }
}

/** A seventh source written only against the adapter contract. */
const fieldbookAdapter: SourceAdapter = {
  sourceSystem: NEW_SYSTEM,
  patterns: ['sources/fieldbook/*.json'],
  parse(files) {
    return files.reduce<CandidateBatch>((batch, file) => {
      const data = JSON.parse(file.content) as FieldbookExport
      const withFile = <T extends { ref: { sourceFile: string } }>(candidate: T): T => ({
        ...candidate,
        ref: { ...candidate.ref, sourceFile: file.path },
      })
      return {
        ...batch,
        providers: [
          ...batch.providers,
          withFile(
            provider(NEW_SYSTEM, data.account, {
              businessName: data.business,
              phones: [data.phone],
              tradesRaw: ['plumbing'],
            }),
          ),
        ],
        properties: [
          ...batch.properties,
          ...[...new Set(data.jobs.map((item) => item.home))].map((home) =>
            withFile(property(NEW_SYSTEM, data.account, home, structured(home, { zip: '75214' }))),
          ),
        ],
        jobs: [
          ...batch.jobs,
          ...data.jobs.map((item) =>
            withFile(
              job(NEW_SYSTEM, data.account, item.id, {
                propertyKey: `${NEW_SYSTEM}:${data.account}:${item.home}`,
                statusRaw: item.status,
                status: item.status === 'done' ? 'completed' : 'scheduled',
                startAt: item.start,
                endAt: item.end,
                timeBasis: 'utc',
                completedAt: item.status === 'done' ? item.end : null,
                tradeRaw: 'water heater repair',
              }),
            ),
          ),
        ],
      }
    }, emptyBatch())
  },
}

/** The profile that describes the same business, as the profiles adapter would emit it. */
const profileAdapter: SourceAdapter = {
  sourceSystem: 'profiles',
  patterns: [PROFILES_FILE],
  parse(files) {
    return files.length === 0
      ? emptyBatch()
      : {
          ...emptyBatch(),
          providers: [
            {
              ...provider('profiles', 'hp_942', {
                businessName: 'Harrow Plumbing',
                phones: ['(214) 555-0142'],
                tradesRaw: ['plumbing'],
                declaredCrm: 'Fieldbook',
              }),
              ref: {
                sourceSystem: 'profiles',
                sourceAccount: 'providers',
                sourceFile: PROFILES_FILE,
                sourceRecordId: 'hp_942',
                ingestedAt: makeCtx().ingestedAt,
              },
            },
          ],
        }
  },
}

const FILES: readonly SourceFile[] = [
  { path: NEW_FILE, content: JSON.stringify(EXPORT) },
  { path: PROFILES_FILE, content: '[]' },
]

function ingest() {
  // The registered list plus one more, exactly as registry.ts would hold it. The real profiles
  // adapter is swapped for a stand-in so the test needs no profile fixture.
  const registered = [
    ...adapters.filter((adapter) => adapter.sourceSystem !== 'profiles'),
    profileAdapter,
    fieldbookAdapter,
  ]
  const paths = FILES.map((file) => file.path)
  const claimed = new Map(
    registered.map((adapter) => [adapter.sourceSystem, claimedBy(adapter, paths)]),
  )
  const claimedPaths = new Set([...claimed.values()].flat())
  const results = runAdapters(
    registered,
    claimed,
    (wanted) => FILES.filter((file) => wanted.includes(file.path)),
    makeCtx(),
  )
  const summary = summarize(
    results,
    paths.filter((filePath) => !claimedPaths.has(filePath)),
  )
  const model = buildCanonical(
    results.map(({ batch }) => batch),
    referenceIndex(),
  )
  return { summary, model }
}

describe('R2: a new source is added by registering one adapter', () => {
  it('R2: its files are claimed and it gets its own summary row', () => {
    const { summary } = ingest()

    expect(summary.unclaimedFiles).toEqual([])
    const row = summary.sources.find((source) => source.sourceSystem === NEW_SYSTEM)
    expect(row).toMatchObject({
      filesRead: 1,
      records: { provider: 1, property: 1, job: 2 },
      jobsByStatus: { completed: 1, scheduled: 1 },
      issues: { info: 0, warn: 0, error: 0 },
    })
  })

  it('R2: its provider merges with the matching profile, which still leads the name', () => {
    const { model } = ingest()

    expect(model.providers).toHaveLength(1)
    const [merged] = model.providers
    expect(merged?.displayName).toBe('Harrow Plumbing')
    expect(merged?.aliases).toContain('Harrow Plumbing Co')
    const linked = model.providerLinks
      .filter((link) => link.entityId === merged?.id)
      .map((link) => link.record)
    expect(linked).toEqual(
      expect.arrayContaining([
        recordKeyOf(
          {
            sourceSystem: NEW_SYSTEM,
            sourceAccount: ACCOUNT,
            sourceFile: NEW_FILE,
            sourceRecordId: ACCOUNT,
            ingestedAt: makeCtx().ingestedAt,
          },
          'provider',
        ),
      ]),
    )
  })

  it('R2: its jobs and home land in the canonical rows with provenance', () => {
    const { model } = ingest()
    const providerId = model.providers[0]?.id

    expect(model.jobs).toHaveLength(2)
    model.jobs.forEach((row) => {
      expect(row.providerId).toBe(providerId)
      expect(row.propertyId).not.toBeNull()
    })
    expect(model.jobs.map((row) => row.status).sort()).toEqual(['completed', 'scheduled'])
    expect(model.properties).toHaveLength(1)
    const jobRecords = model.jobLinks.map((link) => link.record)
    expect(
      jobRecords.filter((record) => record.startsWith(`${NEW_SYSTEM}|${NEW_FILE}|`)),
    ).toHaveLength(2)
  })

  it('R2: a profile naming the new system as its CRM raises no CRM conflict', () => {
    const { model } = ingest()

    expect(model.providerConflicts.filter((conflict) => conflict.kind === 'crm')).toEqual([])
  })
})
