import { describe, expect, it } from 'vitest'
import { jobberAdapter } from '../../../src/adapters/jobber.ts'
import type { JobCandidate } from '../../../src/adapters/types.ts'
import {
  editJson,
  expectAllInstantsUtc,
  expectInstant,
  expectIssuesFreeOf,
  expectProvenance,
  expectUniqueRecordIds,
  issuesFor,
  loadFixtureFiles,
  makeCtx,
  one,
} from './support.ts'

const FILE = 'sources/jobber/maple_leaf_plumbing.json'
const ACCOUNT_ID = 'Z2lkOi8vSm9iYmVyL0FjY291bnQvOTAwMDAwMQ'
const PROVIDER_KEY = 'jobber:maple_leaf_plumbing'

const CLIENT_1 = 'Z2lkOi8vSm9iYmVyL0NsaWVudC85MDAwMTAx'
const PROPERTY_1 = 'Z2lkOi8vSm9iYmVyL1Byb3BlcnR5LzkwMDAyMDE'
const PROPERTY_2 = 'Z2lkOi8vSm9iYmVyL1Byb3BlcnR5LzkwMDAyMDI'
const PROPERTY_3 = 'Z2lkOi8vSm9iYmVyL1Byb3BlcnR5LzkwMDAyMDM'

/** "WH replace": archived, three visits (two completed, one cancelled). */
const JOB_WH = 'Z2lkOi8vSm9iYmVyL0pvYi85MDAwMzAx'
const VISITS_WH = [
  'Z2lkOi8vSm9iYmVyL1Zpc2l0LzkwMDA0MDE',
  'Z2lkOi8vSm9iYmVyL1Zpc2l0LzkwMDA0MDI',
  'Z2lkOi8vSm9iYmVyL1Zpc2l0LzkwMDA0MDM',
]
/** "Leaky kitchen faucet": one UPCOMING visit on 2026-11-03 09:00 local, rescheduled. */
const JOB_FAUCET = 'Z2lkOi8vSm9iYmVyL0pvYi85MDAwMzAy'
const VISIT_FAUCET = 'Z2lkOi8vSm9iYmVyL1Zpc2l0LzkwMDA0MDQ'
/** Recurring drain cleaning: OVERDUE, COMPLETED, UPCOMING visits. */
const JOB_RECURRING = 'Z2lkOi8vSm9iYmVyL0pvYi85MDAwMzAz'
const VISIT_OVERDUE = 'Z2lkOi8vSm9iYmVyL1Zpc2l0LzkwMDA0MDY'
const VISIT_RECURRING_DONE = 'Z2lkOi8vSm9iYmVyL1Zpc2l0LzkwMDA0MDU'
const VISIT_RECURRING_NEXT = 'Z2lkOi8vSm9iYmVyL1Zpc2l0LzkwMDA0MDc'
/** No visits, jobStatus unscheduled. */
const JOB_NO_VISITS_UNSCHEDULED = 'Z2lkOi8vSm9iYmVyL0pvYi85MDAwMzA0'
/** No visits, jobStatus requires_invoicing, total "350.00". */
const JOB_NO_VISITS_INVOICING = 'Z2lkOi8vSm9iYmVyL0pvYi85MDAwMzA1'
const VISIT_UNSCHEDULED = 'Z2lkOi8vSm9iYmVyL1Zpc2l0LzkwMDA0MDk'
const VISIT_TODAY = 'Z2lkOi8vSm9iYmVyL1Zpc2l0LzkwMDA0MDg'

interface JobberVisit {
  visitStatus: string
  startAt: string | null
  endAt: string | null
}
interface JobberJob {
  id: string
  jobStatus: string
  visits: { nodes: JobberVisit[] }
}
interface JobberDoc {
  data: { jobs: { nodes: JobberJob[] } }
}

function parseFixture(files = loadFixtureFiles('jobber')) {
  return jobberAdapter.parse(files, makeCtx())
}

function jobById(jobs: readonly JobCandidate[], id: string): JobCandidate {
  return one(jobs, (job) => job.ref.sourceRecordId === id)
}

function withJob(id: string, edit: (job: JobberJob) => void) {
  return editJson(loadFixtureFiles('jobber'), FILE, (raw) => {
    const doc = raw as JobberDoc
    edit(one(doc.data.jobs.nodes, (job) => job.id === id))
  })
}

describe('jobberAdapter', () => {
  it('declares its source system and data pack pattern', () => {
    expect(jobberAdapter.sourceSystem).toBe('jobber')
    expect(jobberAdapter.patterns.length).toBeGreaterThan(0)
    jobberAdapter.patterns.forEach((pattern) => {
      expect(pattern.startsWith('sources/jobber/')).toBe(true)
    })
  })

  it('is pure: the same input gives the same output', () => {
    expect(parseFixture()).toEqual(parseFixture())
  })

  describe('provenance (R11)', () => {
    it('stamps every candidate and issue with system, account, file, record ID and run time', () => {
      const batch = parseFixture()
      expectProvenance(batch, { sourceSystem: 'jobber', sourceFiles: [FILE] })
      expectUniqueRecordIds(batch)
      batch.providers.forEach((provider) => {
        expect(provider.ref.sourceAccount).toBe('maple_leaf_plumbing')
      })
    })

    it('never puts homeowner PII in issue messages', () => {
      const batch = parseFixture(
        withJob(JOB_FAUCET, (job) => {
          const [visit] = job.visits.nodes
          if (visit) visit.visitStatus = 'MYSTERY'
        }),
      )
      expect(batch.issues.length).toBeGreaterThan(0)
      expectIssuesFreeOf(batch, ['Halvorsen', 'Pemberton', '469-555-0187', 'corinne.h@example.org'])
    })
  })

  describe('provider', () => {
    it('emits one provider per file from the account block', () => {
      const batch = parseFixture()
      expect(batch.providers).toHaveLength(1)
      const provider = one(batch.providers, () => true)
      expect(provider.type).toBe('provider')
      expect(provider.providerKey).toBe(PROVIDER_KEY)
      expect(provider.ref.sourceRecordId).toBe(ACCOUNT_ID)
      expect(provider.businessName).toBe('Maple Leaf Plumbing')
      expect(provider.ownerName).toBe('Dana Whitfield')
      expect(provider.phones).toEqual(['(214) 555-0142'])
      expect(provider.tradesRaw).toContain('PLUMBING')
      expect(provider.declaredServiceZips).toBeNull()
      expect(provider.declaredCrm).toBeNull()
    })
  })

  describe('properties', () => {
    it('emits one property per client property with raw address and client contact', () => {
      const batch = parseFixture()
      expect(batch.properties).toHaveLength(3)

      const first = one(batch.properties, (p) => p.ref.sourceRecordId === PROPERTY_1)
      expect(first.providerKey).toBe(PROVIDER_KEY)
      expect(first.address).toEqual({
        line1: '4518 Live Oak St',
        line2: 'Apt 2',
        city: 'Dallas',
        state: 'TX',
        zip: '75204',
        freeText: null,
      })
      expect(first.contact).toEqual({
        sourceCustomerId: CLIENT_1,
        name: 'Corinne Halvorsen',
        phones: ['469-555-0187'],
        emails: ['corinne.h@example.org'],
      })
    })

    it('keeps null and odd address parts as given, for the shared normalizer', () => {
      const batch = parseFixture()
      const second = one(batch.properties, (p) => p.ref.sourceRecordId === PROPERTY_2)
      expect(second.address).toEqual({
        line1: '5841 belmont ave',
        line2: null,
        city: null,
        state: 'Texas',
        zip: '75206-1234',
        freeText: null,
      })
      expect(second.contact?.emails).toEqual([])

      const third = one(batch.properties, (p) => p.ref.sourceRecordId === PROPERTY_3)
      expect(third.address.zip).toBeNull()
    })

    it('gives every property a distinct key that jobs can reference', () => {
      const keys = parseFixture().properties.map((p) => p.propertyKey)
      expect(new Set(keys).size).toBe(3)
    })
  })

  describe('jobs and visits', () => {
    it('yields one visit candidate per visit, all linked to one parent (R4 a)', () => {
      const batch = parseFixture()
      const visits = batch.jobs.filter((job) => job.parentSourceRecordId === JOB_WH)
      expect(visits.map((v) => v.ref.sourceRecordId).sort()).toEqual([...VISITS_WH].sort())
      visits.forEach((visit) => {
        expect(visit.kind).toBe('visit')
        expect(visit.providerKey).toBe(PROVIDER_KEY)
        expect(visit.tradeRaw).toBe('WH replace')
      })
    })

    it('links visits to the property of their job', () => {
      const batch = parseFixture()
      const property = one(batch.properties, (p) => p.ref.sourceRecordId === PROPERTY_1)
      VISITS_WH.forEach((id) => {
        expect(jobById(batch.jobs, id).propertyKey).toBe(property.propertyKey)
      })
    })

    it('keeps UTC "Z" timestamps as the same instants (R4 b)', () => {
      const batch = parseFixture()
      const visit = jobById(batch.jobs, VISITS_WH[0] ?? '')
      expectInstant(visit.startAt, '2026-10-12T14:00:00Z')
      expectInstant(visit.endAt, '2026-10-12T16:30:00Z')
      expectInstant(visit.completedAt, '2026-10-12T16:30:00Z')
      expect(visit.timeBasis).toBe('utc')
      expect(visit.allDay).toBe(false)
      expectInstant(visit.sourceCreatedAt, '2026-10-05T16:00:00Z')
      expectAllInstantsUtc(batch)
    })

    it('keeps a missing end as null, never invented', () => {
      const overdue = jobById(parseFixture().jobs, VISIT_OVERDUE)
      expectInstant(overdue.startAt, '2026-10-03T14:00:00Z')
      expect(overdue.endAt).toBeNull()
    })

    it('reads visit money as integer cents', () => {
      const batch = parseFixture()
      expect(jobById(batch.jobs, VISITS_WH[0] ?? '').amountCents).toBe(60000)
      expect(jobById(batch.jobs, VISITS_WH[1] ?? '').amountCents).toBe(63450)
      expect(jobById(batch.jobs, VISIT_RECURRING_DONE).amountCents).toBe(9500)
    })

    it('treats an absent or null invoicedAmount as unknown, not zero', () => {
      const batch = parseFixture()
      expect(jobById(batch.jobs, VISITS_WH[2] ?? '').amountCents).toBeNull()
      expect(jobById(batch.jobs, VISIT_FAUCET).amountCents).toBeNull()
    })

    it('emits one job candidate per job with no visits, total dollars in cents', () => {
      const batch = parseFixture()
      const invoicing = jobById(batch.jobs, JOB_NO_VISITS_INVOICING)
      expect(invoicing.kind).toBe('job')
      expect(invoicing.parentSourceRecordId).toBeNull()
      expect(invoicing.amountCents).toBe(35000)
      expect(invoicing.amountRaw).toBe('350.00')
      expect(invoicing.startAt).toBeNull()
      expect(invoicing.endAt).toBeNull()
      expect(invoicing.timeBasis).toBeNull()
      expect(invoicing.tradeRaw).toBe('Sewer line camera')

      const unscheduled = jobById(batch.jobs, JOB_NO_VISITS_UNSCHEDULED)
      expect(unscheduled.kind).toBe('job')
      expect(unscheduled.amountCents).toBe(0)
    })

    it('marks visits of a recurring job as recurring', () => {
      const batch = parseFixture()
      const recurring = batch.jobs.filter((job) => job.parentSourceRecordId === JOB_RECURRING)
      expect(recurring).toHaveLength(3)
      recurring.forEach((visit) => {
        expect(visit.isRecurring).toBe(true)
      })
      expect(jobById(batch.jobs, VISIT_FAUCET).isRecurring).toBe(false)
    })

    it('keeps reschedule instructions as evidence', () => {
      const visit = jobById(parseFixture().jobs, VISIT_FAUCET)
      expect(visit.rescheduleNote).toContain('Rescheduled from 10/29')
    })
  })

  describe('status mapping (R9)', () => {
    it('uses visitStatus for visits', () => {
      const batch = parseFixture()
      const statusOf = (id: string) => {
        const job = jobById(batch.jobs, id)
        return { raw: job.statusRaw, status: job.status }
      }
      expect(statusOf(VISITS_WH[0] ?? '')).toEqual({ raw: 'COMPLETED', status: 'completed' })
      expect(statusOf(VISITS_WH[2] ?? '')).toEqual({ raw: 'CANCELLED', status: 'cancelled' })
      expect(statusOf(VISIT_FAUCET)).toEqual({ raw: 'UPCOMING', status: 'scheduled' })
      expect(statusOf(VISIT_TODAY)).toEqual({ raw: 'TODAY', status: 'scheduled' })
      expect(statusOf(VISIT_OVERDUE)).toEqual({ raw: 'OVERDUE', status: 'limbo' })
      expect(statusOf(VISIT_UNSCHEDULED)).toEqual({ raw: 'UNSCHEDULED', status: 'unscheduled' })
      expect(statusOf(VISIT_RECURRING_NEXT).status).toBe('scheduled')
    })

    it('uses jobStatus for jobs without visits', () => {
      const batch = parseFixture()
      expect(jobById(batch.jobs, JOB_NO_VISITS_INVOICING).status).toBe('completed')
      expect(jobById(batch.jobs, JOB_NO_VISITS_UNSCHEDULED).status).toBe('unscheduled')
    })

    it.each([
      ['archived', 'completed'],
      ['requires_invoicing', 'completed'],
      ['upcoming', 'scheduled'],
      ['today', 'scheduled'],
      ['active', 'in_progress'],
      ['action_required', 'on_hold'],
      ['unscheduled', 'unscheduled'],
    ])('maps jobStatus %j on a job without visits to %j', (raw, status) => {
      const files = withJob(JOB_NO_VISITS_INVOICING, (job) => {
        job.jobStatus = raw
      })
      const job = jobById(parseFixture(files).jobs, JOB_NO_VISITS_INVOICING)
      expect(job.statusRaw).toBe(raw)
      expect(job.status).toBe(status)
    })

    it.each([
      ['COMPLETED', 'completed'],
      ['UPCOMING', 'scheduled'],
      ['TODAY', 'scheduled'],
      ['CANCELLED', 'cancelled'],
      ['OVERDUE', 'limbo'],
      ['UNSCHEDULED', 'unscheduled'],
    ])('maps visitStatus %j to %j', (raw, status) => {
      const files = withJob(JOB_FAUCET, (job) => {
        const [visit] = job.visits.nodes
        if (visit) visit.visitStatus = raw
      })
      expect(jobById(parseFixture(files).jobs, VISIT_FAUCET).status).toBe(status)
    })

    it('turns an UPCOMING visit that ended before now into limbo (R9 d)', () => {
      const files = withJob(JOB_FAUCET, (job) => {
        const [visit] = job.visits.nodes
        if (!visit) return
        visit.startAt = '2026-10-27T15:00:00Z'
        visit.endAt = '2026-10-27T17:00:00Z'
      })
      const visit = jobById(parseFixture(files).jobs, VISIT_FAUCET)
      expect(visit.statusRaw).toBe('UPCOMING')
      expect(visit.status).toBe('limbo')
    })

    it('maps an unknown status to limbo and reports it, without dropping the record', () => {
      const files = withJob(JOB_FAUCET, (job) => {
        const [visit] = job.visits.nodes
        if (visit) visit.visitStatus = 'MYSTERY'
      })
      const batch = parseFixture(files)
      const visit = jobById(batch.jobs, VISIT_FAUCET)
      expect(visit.statusRaw).toBe('MYSTERY')
      expect(visit.status).toBe('limbo')
      const issues = issuesFor(batch, VISIT_FAUCET)
      expect(issues.map((issue) => issue.code)).toContain('status.unmapped')
    })

    it('reports no errors and no unmapped statuses on the clean fixture', () => {
      const batch = parseFixture()
      expect(batch.issues.filter((issue) => issue.severity === 'error')).toEqual([])
      expect(batch.issues.filter((issue) => issue.code === 'status.unmapped')).toEqual([])
    })
  })

  it('produces no calendar blocks or declared hours', () => {
    const batch = parseFixture()
    expect(batch.calendarBlocks).toEqual([])
    expect(batch.declaredHours).toEqual([])
  })

  it('handles several account files in one parse, one provider each', () => {
    const files = loadFixtureFiles('jobber')
    const [original] = files
    if (!original) throw new Error('fixture missing')
    const copy = { path: 'sources/jobber/second_account.json', content: original.content }
    const batch = jobberAdapter.parse([original, copy], makeCtx())
    expect(batch.providers.map((p) => p.providerKey).sort()).toEqual([
      PROVIDER_KEY,
      'jobber:second_account',
    ])
    expect(batch.jobs.filter((job) => job.ref.sourceFile === copy.path)).toHaveLength(
      batch.jobs.filter((job) => job.ref.sourceFile === FILE).length,
    )
  })
})
