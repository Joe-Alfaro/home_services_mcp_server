import { describe, expect, it } from 'vitest'
import type { JobCandidate, PropertyCandidate } from '../../../src/adapters/types.ts'
import { workizAdapter } from '../../../src/adapters/workiz.ts'
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

const DIR = 'sources/workiz/trinity_rooter'
const JOBS_FILE = `${DIR}/jobs.json`
const ACCOUNT_FILE = `${DIR}/account.json`
const PROVIDER_KEY = 'workiz:trinity_rooter'

/** Done, 2026-10-31 09:00-11:00 local, "WH replace", "$1460", client 7001. */
const JOB_DONE = 'K7P2QX'
/** Pending / Scheduled, 2026-11-02 09:00-10:30 local, "$1,234.50", rescheduled, client 7001. */
const JOB_SCHEDULED = 'M3D8LV'
/** Pending / On Hold, "385", client 7002 unit B, city "". */
const JOB_ON_HOLD = 'R5T1WB'
/** Canceled / No show, "1234.5", client 7003, PostalCode "". */
const JOB_NO_SHOW = 'H9C4NE'
/** Submitted with no date, price "", client 7002 (same address as JOB_ON_HOLD). */
const JOB_SUBMITTED = 'Z2G6UA'
/** Pending / Scheduled but dated 2026-10-28: stale. Client 7003 at a second address. */
const JOB_STALE = 'J4F7SY'
/** Done Pending Approval, client 7001. */
const JOB_PENDING_APPROVAL = 'Q8N3RD'

interface WorkizJob {
  UUID: string
  Status: string
  SubStatus: string
  JobDateTime: string
  JobEndDateTime: string
}
interface WorkizJobs {
  data: WorkizJob[]
}

function parseFixture(files = loadFixtureFiles('workiz')) {
  return workizAdapter.parse(files, makeCtx())
}

function jobById(jobs: readonly JobCandidate[], id: string): JobCandidate {
  return one(jobs, (job) => job.ref.sourceRecordId === id)
}

function propertyOf(
  batch: { properties: readonly PropertyCandidate[]; jobs: readonly JobCandidate[] },
  jobId: string,
): PropertyCandidate {
  const { propertyKey } = jobById(batch.jobs, jobId)
  return one(batch.properties, (p) => p.propertyKey === propertyKey)
}

function withJob(id: string, edit: (job: WorkizJob) => void) {
  return editJson(loadFixtureFiles('workiz'), JOBS_FILE, (raw) => {
    const doc = raw as WorkizJobs
    edit(one(doc.data, (job) => job.UUID === id))
  })
}

describe('workizAdapter', () => {
  it('declares its source system and data pack pattern', () => {
    expect(workizAdapter.sourceSystem).toBe('workiz')
    expect(workizAdapter.patterns.length).toBeGreaterThan(0)
    workizAdapter.patterns.forEach((pattern) => {
      expect(pattern.startsWith('sources/workiz/')).toBe(true)
    })
  })

  it('is pure: the same input gives the same output', () => {
    expect(parseFixture()).toEqual(parseFixture())
  })

  describe('provenance (R11)', () => {
    it('stamps every candidate with system, account folder, file, record ID and run time', () => {
      const batch = parseFixture()
      expectProvenance(batch, { sourceSystem: 'workiz', sourceFiles: [ACCOUNT_FILE, JOBS_FILE] })
      expectUniqueRecordIds(batch)
      batch.jobs.forEach((job) => {
        expect(job.ref.sourceAccount).toBe('trinity_rooter')
        expect(job.ref.sourceFile).toBe(JOBS_FILE)
      })
    })

    it('derives property record IDs from the job that introduced the address', () => {
      parseFixture().properties.forEach((property) => {
        expect(property.ref.sourceRecordId).toMatch(/#address$/)
        expect(property.ref.sourceFile).toBe(JOBS_FILE)
      })
    })

    it('never puts homeowner PII in issue messages', () => {
      expectIssuesFreeOf(parseFixture(), ['Brightwater', 'Ambrose', '972.555.0193', 'nadia.b@'])
    })
  })

  describe('provider', () => {
    it('emits one provider per account folder from account.json', () => {
      const provider = one(parseFixture().providers, () => true)
      expect(provider.providerKey).toBe(PROVIDER_KEY)
      expect(provider.ref.sourceRecordId).toBe('TR98ZQ01')
      expect(provider.ref.sourceFile).toBe(ACCOUNT_FILE)
      expect(provider.businessName).toBe('Trinity Rooter')
      expect(provider.phones).toEqual(['(469) 555-0104'])
    })
  })

  describe('properties', () => {
    it('emits one property per distinct (ClientId, address) in jobs', () => {
      const batch = parseFixture()
      expect(batch.properties).toHaveLength(4)
      expect(propertyOf(batch, JOB_DONE).propertyKey).toBe(
        propertyOf(batch, JOB_SCHEDULED).propertyKey,
      )
      expect(propertyOf(batch, JOB_DONE).propertyKey).toBe(
        propertyOf(batch, JOB_PENDING_APPROVAL).propertyKey,
      )
      expect(propertyOf(batch, JOB_ON_HOLD).propertyKey).toBe(
        propertyOf(batch, JOB_SUBMITTED).propertyKey,
      )
      // Same client, two different addresses.
      expect(propertyOf(batch, JOB_NO_SHOW).propertyKey).not.toBe(
        propertyOf(batch, JOB_STALE).propertyKey,
      )
    })

    it('turns "" into null and keeps the bare unit as line2', () => {
      const batch = parseFixture()
      expect(propertyOf(batch, JOB_ON_HOLD).address).toEqual({
        line1: '5833 Belmont Ave',
        line2: 'B',
        city: null,
        state: 'TX',
        zip: '75206-4410',
        freeText: null,
      })
      expect(propertyOf(batch, JOB_DONE).address).toEqual({
        line1: '4541 Live Oak St',
        line2: null,
        city: 'DALLAS',
        state: 'TX',
        zip: '75204',
        freeText: null,
      })
      expect(propertyOf(batch, JOB_NO_SHOW).address.zip).toBeNull()
    })

    it('keeps the client contact, without empty strings', () => {
      const batch = parseFixture()
      expect(propertyOf(batch, JOB_DONE).contact).toEqual({
        sourceCustomerId: '7001',
        name: 'Nadia Brightwater',
        phones: ['+1 214 555 0126'],
        emails: ['nadia.b@example.com'],
      })
      expect(propertyOf(batch, JOB_ON_HOLD).contact?.emails).toEqual([])
    })
  })

  describe('jobs', () => {
    it('emits one job per row, all kind "job"', () => {
      const batch = parseFixture()
      expect(batch.jobs.map((job) => job.ref.sourceRecordId).sort()).toEqual(
        [
          JOB_DONE,
          JOB_SCHEDULED,
          JOB_ON_HOLD,
          JOB_NO_SHOW,
          JOB_SUBMITTED,
          JOB_STALE,
          JOB_PENDING_APPROVAL,
        ].sort(),
      )
      batch.jobs.forEach((job) => {
        expect(job.kind).toBe('job')
        expect(job.providerKey).toBe(PROVIDER_KEY)
        expect(job.parentSourceRecordId).toBeNull()
      })
    })

    it('interprets zone-less "YYYY-MM-DD HH:MM:SS" as Chicago local time across DST (R12)', () => {
      const batch = parseFixture()
      const cdt = jobById(batch.jobs, JOB_DONE)
      expectInstant(cdt.startAt, '2026-10-31T14:00:00Z')
      expectInstant(cdt.endAt, '2026-10-31T16:00:00Z')
      expect(cdt.timeBasis).toBe('local_assumed')

      const cst = jobById(batch.jobs, JOB_SCHEDULED)
      expectInstant(cst.startAt, '2026-11-02T15:00:00Z')
      expectInstant(cst.endAt, '2026-11-02T16:30:00Z')
      expectAllInstantsUtc(batch)
    })

    it('turns an empty date into no slot', () => {
      const job = jobById(parseFixture().jobs, JOB_SUBMITTED)
      expect(job.startAt).toBeNull()
      expect(job.endAt).toBeNull()
      expect(job.timeBasis).toBeNull()
    })

    it('keeps the free-text JobType verbatim as the trade text (R4 f)', () => {
      const batch = parseFixture()
      expect(jobById(batch.jobs, JOB_DONE).tradeRaw).toBe('WH replace')
      expect(jobById(batch.jobs, JOB_SCHEDULED).tradeRaw).toBe('wh no hot water')
    })

    it.each([
      [JOB_DONE, '$1460', 146000],
      [JOB_SCHEDULED, '$1,234.50', 123450],
      [JOB_ON_HOLD, '385', 38500],
      [JOB_NO_SHOW, '1234.5', 123450],
    ])('reads %s price %j as %i cents (R4 e)', (id, raw, cents) => {
      const job = jobById(parseFixture().jobs, id)
      expect(job.amountRaw).toBe(raw)
      expect(job.amountCents).toBe(cents)
    })

    it('treats an empty price as unknown', () => {
      const job = jobById(parseFixture().jobs, JOB_SUBMITTED)
      expect(job.amountCents).toBeNull()
      expect(job.amountRaw).toBeNull()
    })

    it('keeps reschedule notes as evidence and empty notes as null', () => {
      const batch = parseFixture()
      expect(jobById(batch.jobs, JOB_SCHEDULED).rescheduleNote).toContain('Rescheduled from 10/30')
      expect(jobById(batch.jobs, JOB_DONE).rescheduleNote).toBeNull()
      expect(jobById(batch.jobs, JOB_DONE).notesRaw).toBeNull()
    })
  })

  describe('status mapping (R9)', () => {
    it('maps the fixture rows and keeps "Status / SubStatus" as the raw value', () => {
      const batch = parseFixture()
      const statusOf = (id: string) => jobById(batch.jobs, id).status
      expect(statusOf(JOB_DONE)).toBe('completed')
      expect(statusOf(JOB_PENDING_APPROVAL)).toBe('completed')
      expect(statusOf(JOB_SCHEDULED)).toBe('scheduled')
      expect(statusOf(JOB_ON_HOLD)).toBe('on_hold')
      expect(statusOf(JOB_NO_SHOW)).toBe('cancelled')
      expect(statusOf(JOB_SUBMITTED)).toBe('unscheduled')
      expect(jobById(batch.jobs, JOB_NO_SHOW).statusRaw).toContain('Canceled')
      expect(jobById(batch.jobs, JOB_NO_SHOW).statusRaw).toContain('No show')
    })

    it.each([
      ['Done', '', 'completed'],
      ['Done Pending Approval', '', 'completed'],
      ['Pending', 'Scheduled', 'scheduled'],
      ['Pending', 'On Hold', 'on_hold'],
      ['Pending', 'Waiting for parts', 'on_hold'],
      ['Pending', 'Waiting for client', 'on_hold'],
      ['Canceled', '', 'cancelled'],
      ['Canceled', 'No show', 'cancelled'],
      ['Canceled', 'Customer canceled', 'cancelled'],
      ['Submitted', '', 'scheduled'],
    ])('maps %j / %j with a future slot to %j', (status, subStatus, expected) => {
      const files = withJob(JOB_SCHEDULED, (job) => {
        job.Status = status
        job.SubStatus = subStatus
      })
      expect(jobById(parseFixture(files).jobs, JOB_SCHEDULED).status).toBe(expected)
    })

    it('turns a Pending / Scheduled row dated in the past into limbo (R9 d)', () => {
      const job = jobById(parseFixture().jobs, JOB_STALE)
      expect(job.status).toBe('limbo')
    })

    it('maps an unknown status to limbo and reports it', () => {
      const files = withJob(JOB_SCHEDULED, (job) => {
        job.Status = 'Teleported'
        job.SubStatus = ''
      })
      const batch = parseFixture(files)
      expect(jobById(batch.jobs, JOB_SCHEDULED).status).toBe('limbo')
      expect(issuesFor(batch, JOB_SCHEDULED).map((i) => i.code)).toContain('status.unmapped')
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
})
