import { describe, expect, it } from 'vitest'
import { housecallProAdapter } from '../../../src/adapters/housecallPro.ts'
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

const DIR = 'sources/housecall_pro/bluebonnet_drain_co'
const FILES = [
  `${DIR}/company.json`,
  `${DIR}/customers_page_1.json`,
  `${DIR}/customers_page_2.json`,
  `${DIR}/estimates_page_1.json`,
  `${DIR}/jobs_page_1.json`,
  `${DIR}/jobs_page_2.json`,
]
const PROVIDER_KEY = 'housecall_pro:bluebonnet_drain_co'
const COMPANY_ID = 'com_0000000000000000000000000000b001'

const ADDR_BELMONT = 'adr_00000000000000000000000000000a01'
const ADDR_LIVE_OAK_APT = 'adr_00000000000000000000000000000a02'
const ADDR_SECOND_OF_TWO = 'adr_00000000000000000000000000000a04'

/** complete rated, 2026-10-31 09:00-12:00 local (CDT), 28500 cents. */
const JOB_WATER_HEATER = 'job_00000000000000000000000000000d01'
/** complete unrated, 2026-11-01 01:30-03:00 local: the repeated DST hour. */
const JOB_DST_NIGHT = 'job_00000000000000000000000000000d02'
/** scheduled 2026-12-02 12:15 local; repeated on page 1 and page 2. */
const JOB_PAGE_BOUNDARY = 'job_00000000000000000000000000000d03'
/** pro canceled, 2026-11-02 09:00 local (CST), on page 2 only. */
const JOB_CANCELLED = 'job_00000000000000000000000000000d04'
/** needs scheduling, schedule null. */
const JOB_NEEDS_SCHEDULING = 'job_00000000000000000000000000000d05'
/** scheduled, but its slot (2026-10-30) is before now. */
const JOB_STALE = 'job_00000000000000000000000000000d06'

const EST_DONE = 'est_00000000000000000000000000000e01'
const EST_UPCOMING = 'est_00000000000000000000000000000e02'

interface HcpJob {
  id: string
  work_status: string
  schedule: { scheduled_start: string; scheduled_end: string } | null
}
interface HcpJobsPage {
  jobs: HcpJob[]
}

function parseFixture(files = loadFixtureFiles('housecall_pro')) {
  return housecallProAdapter.parse(files, makeCtx())
}

function jobById(jobs: readonly JobCandidate[], id: string): JobCandidate {
  return one(jobs, (job) => job.ref.sourceRecordId === id)
}

function withJobOnPage1(id: string, edit: (job: HcpJob) => void) {
  return editJson(loadFixtureFiles('housecall_pro'), `${DIR}/jobs_page_1.json`, (raw) => {
    const doc = raw as HcpJobsPage
    edit(one(doc.jobs, (job) => job.id === id))
  })
}

describe('housecallProAdapter', () => {
  it('declares its source system and data pack pattern', () => {
    expect(housecallProAdapter.sourceSystem).toBe('housecall_pro')
    expect(housecallProAdapter.patterns.length).toBeGreaterThan(0)
    housecallProAdapter.patterns.forEach((pattern) => {
      expect(pattern.startsWith('sources/housecall_pro/')).toBe(true)
    })
  })

  it('is pure: the same input gives the same output', () => {
    expect(parseFixture()).toEqual(parseFixture())
  })

  it('does not depend on the order files are passed in', () => {
    const files = loadFixtureFiles('housecall_pro')
    const reversed = housecallProAdapter.parse([...files].reverse(), makeCtx())
    const sortIds = (jobs: readonly JobCandidate[]) => jobs.map((j) => j.ref.sourceRecordId).sort()
    expect(sortIds(reversed.jobs)).toEqual(sortIds(parseFixture(files).jobs))
  })

  describe('provenance (R11)', () => {
    it('stamps every candidate with system, company folder, file, record ID and run time', () => {
      const batch = parseFixture()
      expectProvenance(batch, { sourceSystem: 'housecall_pro', sourceFiles: FILES })
      expectUniqueRecordIds(batch)
      batch.jobs.forEach((job) => {
        expect(job.ref.sourceAccount).toBe('bluebonnet_drain_co')
      })
    })

    it('cites the page file a job came from', () => {
      const batch = parseFixture()
      expect(jobById(batch.jobs, JOB_WATER_HEATER).ref.sourceFile).toBe(`${DIR}/jobs_page_1.json`)
      expect(jobById(batch.jobs, JOB_CANCELLED).ref.sourceFile).toBe(`${DIR}/jobs_page_2.json`)
      expect(jobById(batch.jobs, EST_DONE).ref.sourceFile).toBe(`${DIR}/estimates_page_1.json`)
    })

    it('never puts homeowner PII in issue messages', () => {
      expectIssuesFreeOf(parseFixture(), ['Okonkwo', 'Marchetti', '972-555-0131', 'theo.m@'])
    })
  })

  describe('provider', () => {
    it('emits one provider per company folder from company.json', () => {
      const batch = parseFixture()
      const provider = one(batch.providers, () => true)
      expect(provider.providerKey).toBe(PROVIDER_KEY)
      expect(provider.ref.sourceRecordId).toBe(COMPANY_ID)
      expect(provider.ref.sourceFile).toBe(`${DIR}/company.json`)
      expect(provider.businessName).toBe('Bluebonnet Drain Co LLC')
      expect(provider.phones).toEqual(['214.555.0177'])
      expect(provider.emails).toEqual(['office@bluebonnetdrain.example.com'])
      expect(provider.baseAddress).toEqual({
        line1: null,
        line2: null,
        city: 'Dallas',
        state: 'TX',
        zip: '75206',
        freeText: null,
      })
    })
  })

  describe('properties', () => {
    it('emits one property per customer address across every customers page (R1 d)', () => {
      const batch = parseFixture()
      expect(batch.properties.map((p) => p.ref.sourceRecordId).sort()).toEqual([
        'adr_00000000000000000000000000000a01',
        'adr_00000000000000000000000000000a02',
        'adr_00000000000000000000000000000a03',
        'adr_00000000000000000000000000000a04',
      ])
    })

    it('keeps the raw address and the customer contact', () => {
      const batch = parseFixture()
      const apt = one(batch.properties, (p) => p.ref.sourceRecordId === ADDR_LIVE_OAK_APT)
      expect(apt.address).toEqual({
        line1: '4533 LIVE OAK ST',
        line2: 'Apt. 4',
        city: null,
        state: 'TX',
        zip: '75204',
        freeText: null,
      })
      expect(apt.contact).toEqual({
        sourceCustomerId: 'cus_00000000000000000000000000000c02',
        name: 'Priya Okonkwo',
        phones: ['(214) 555-0158'],
        emails: [],
      })
      expect(apt.ref.sourceFile).toBe(`${DIR}/customers_page_1.json`)

      const second = one(batch.properties, (p) => p.ref.sourceRecordId === ADDR_SECOND_OF_TWO)
      expect(second.address.zip).toBe('75204-3311')
      expect(second.contact?.sourceCustomerId).toBe('cus_00000000000000000000000000000c03')
      expect(second.ref.sourceFile).toBe(`${DIR}/customers_page_2.json`)
    })

    it('links jobs to the property of their address id', () => {
      const batch = parseFixture()
      const belmont = one(batch.properties, (p) => p.ref.sourceRecordId === ADDR_BELMONT)
      expect(jobById(batch.jobs, JOB_WATER_HEATER).propertyKey).toBe(belmont.propertyKey)
      expect(jobById(batch.jobs, EST_UPCOMING).propertyKey).toBe(belmont.propertyKey)
    })
  })

  describe('jobs', () => {
    it('reads every jobs page and keeps one candidate per job id (R1 d)', () => {
      const batch = parseFixture()
      const jobIds = batch.jobs.filter((j) => j.kind === 'job').map((j) => j.ref.sourceRecordId)
      // total_items in jobs_page_1.json is 6; one job is repeated across the page boundary.
      expect(jobIds.sort()).toEqual(
        [
          JOB_WATER_HEATER,
          JOB_DST_NIGHT,
          JOB_PAGE_BOUNDARY,
          JOB_CANCELLED,
          JOB_NEEDS_SCHEDULING,
          JOB_STALE,
        ].sort(),
      )
    })

    it('reports the repeated page row instead of dropping it silently', () => {
      const issues = issuesFor(parseFixture(), JOB_PAGE_BOUNDARY)
      expect(issues.length).toBeGreaterThan(0)
      issues.forEach((issue) => {
        expect(issue.severity).toBe('warn')
      })
      // G3: the issue names both pages the row appeared on.
      const messages = issues.map((issue) => issue.message).join(' ')
      expect(messages).toContain('jobs_page_1')
      expect(messages).toContain('jobs_page_2')
    })

    it('reads pages in numeric order, so page 10 is not mistaken for page 1', () => {
      const files = loadFixtureFiles('housecall_pro').map((file) =>
        file.path === `${DIR}/jobs_page_2.json`
          ? { path: `${DIR}/jobs_page_10.json`, content: file.content }
          : file,
      )
      const batch = parseFixture(files)
      expect(jobById(batch.jobs, JOB_CANCELLED).ref.sourceFile).toBe(`${DIR}/jobs_page_10.json`)
      // The first occurrence of the repeated job is the one on the lower page number.
      expect(jobById(batch.jobs, JOB_PAGE_BOUNDARY).ref.sourceFile).toBe(`${DIR}/jobs_page_1.json`)
    })

    it('interprets zone-less schedule times as Chicago local time (R4 d, R12)', () => {
      const batch = parseFixture()
      const boundary = jobById(batch.jobs, JOB_PAGE_BOUNDARY)
      expectInstant(boundary.startAt, '2026-12-02T18:15:00Z')
      expectInstant(boundary.endAt, '2026-12-02T20:15:00Z')
      expect(boundary.timeBasis).toBe('local_assumed')
      expect(boundary.allDay).toBe(false)

      const cdt = jobById(batch.jobs, JOB_WATER_HEATER)
      expectInstant(cdt.startAt, '2026-10-31T14:00:00Z')
      expectInstant(cdt.endAt, '2026-10-31T17:00:00Z')
      expectInstant(cdt.completedAt, '2026-10-31T16:50:00Z')

      const cst = jobById(batch.jobs, JOB_CANCELLED)
      expectInstant(cst.startAt, '2026-11-02T15:00:00Z')
      expectAllInstantsUtc(batch)
    })

    it('keeps created_at, which is already UTC, as the same instant', () => {
      expectInstant(
        jobById(parseFixture().jobs, JOB_WATER_HEATER).sourceCreatedAt,
        '2026-10-20T15:00:00Z',
      )
    })

    it('resolves the repeated 01:30 hour to the earlier instant and flags it', () => {
      const batch = parseFixture()
      const job = jobById(batch.jobs, JOB_DST_NIGHT)
      expectInstant(job.startAt, '2026-11-01T06:30:00Z')
      expectInstant(job.endAt, '2026-11-01T09:00:00Z')
      const codes = issuesFor(batch, JOB_DST_NIGHT).map((issue) => issue.code)
      expect(codes).toContain('time.ambiguous_local')
    })

    it('keeps amounts that are already integer cents (R4 e)', () => {
      const batch = parseFixture()
      expect(jobById(batch.jobs, JOB_WATER_HEATER).amountCents).toBe(28500)
      expect(jobById(batch.jobs, JOB_CANCELLED).amountCents).toBe(0)
    })

    it('leaves a job with no schedule unslotted', () => {
      const job = jobById(parseFixture().jobs, JOB_NEEDS_SCHEDULING)
      expect(job.startAt).toBeNull()
      expect(job.endAt).toBeNull()
      expect(job.timeBasis).toBeNull()
      expect(job.status).toBe('unscheduled')
    })

    it('keeps the description as the trade text and the notes as reschedule evidence', () => {
      const batch = parseFixture()
      expect(jobById(batch.jobs, JOB_WATER_HEATER).tradeRaw).toBe('replace water heater 50 gal')
      expect(jobById(batch.jobs, JOB_PAGE_BOUNDARY).rescheduleNote).toContain(
        'Rescheduled from 11/30',
      )
    })

    it('has no parent links', () => {
      parseFixture().jobs.forEach((job) => {
        expect(job.parentSourceRecordId).toBeNull()
      })
    })
  })

  describe('estimates (R4 c)', () => {
    it('emits estimates as kind "estimate", never as jobs', () => {
      const batch = parseFixture()
      const estimates = batch.jobs.filter((job) => job.kind === 'estimate')
      expect(estimates.map((e) => e.ref.sourceRecordId).sort()).toEqual([EST_DONE, EST_UPCOMING])
    })

    it('keeps a completed estimate an estimate, so it never counts as completed work', () => {
      const done = jobById(parseFixture().jobs, EST_DONE)
      expect(done.kind).toBe('estimate')
      expect(done.statusRaw).toBe('complete rated')
      expect(done.status).toBe('completed')
    })

    it('gives a scheduled estimate a slot so it blocks time', () => {
      const upcoming = jobById(parseFixture().jobs, EST_UPCOMING)
      expect(upcoming.status).toBe('scheduled')
      expectInstant(upcoming.startAt, '2026-11-05T20:00:00Z')
      expectInstant(upcoming.endAt, '2026-11-05T21:00:00Z')
      expect(upcoming.tradeRaw).toContain('water heater swap')
    })
  })

  describe('status mapping (R9)', () => {
    it('maps the fixture statuses', () => {
      const batch = parseFixture()
      expect(jobById(batch.jobs, JOB_WATER_HEATER).status).toBe('completed')
      expect(jobById(batch.jobs, JOB_DST_NIGHT).status).toBe('completed')
      expect(jobById(batch.jobs, JOB_PAGE_BOUNDARY).status).toBe('scheduled')
      expect(jobById(batch.jobs, JOB_CANCELLED).status).toBe('cancelled')
    })

    it.each([
      ['complete rated', 'completed'],
      ['complete unrated', 'completed'],
      ['scheduled', 'scheduled'],
      ['pro canceled', 'cancelled'],
      ['user canceled', 'cancelled'],
      ['needs scheduling', 'unscheduled'],
    ])('maps work_status %j to %j', (raw, status) => {
      const files = withJobOnPage1(JOB_WATER_HEATER, (job) => {
        job.work_status = raw
        job.schedule = {
          scheduled_start: '2026-11-10T09:00:00',
          scheduled_end: '2026-11-10T10:00:00',
        }
      })
      const job = jobById(parseFixture(files).jobs, JOB_WATER_HEATER)
      expect(job.statusRaw).toBe(raw)
      expect(job.status).toBe(status)
    })

    it('turns a scheduled job whose slot is already over into limbo (R9 d)', () => {
      const job = jobById(parseFixture().jobs, JOB_STALE)
      expect(job.statusRaw).toBe('scheduled')
      expect(job.status).toBe('limbo')
    })

    it('maps an unknown status to limbo and reports it', () => {
      const files = withJobOnPage1(JOB_WATER_HEATER, (job) => {
        job.work_status = 'on the moon'
      })
      const batch = parseFixture(files)
      expect(jobById(batch.jobs, JOB_WATER_HEATER).status).toBe('limbo')
      expect(issuesFor(batch, JOB_WATER_HEATER).map((i) => i.code)).toContain('status.unmapped')
    })

    it('reports no errors on the clean fixture', () => {
      expect(parseFixture().issues.filter((issue) => issue.severity === 'error')).toEqual([])
    })
  })

  it('produces no calendar blocks or declared hours', () => {
    const batch = parseFixture()
    expect(batch.calendarBlocks).toEqual([])
    expect(batch.declaredHours).toEqual([])
  })
})
