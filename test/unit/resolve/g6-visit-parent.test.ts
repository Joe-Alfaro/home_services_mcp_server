/*
 * G6: a CRM A (Jobber-style) job with many visits is one piece of work. The adapter output fed
 * through the job resolver must give one canonical parent job and one visit row per listed visit,
 * each visit pointing at the parent through parentJobId. Today every visit has parentJobId null
 * because no candidate for the parent job itself ever becomes a canonical row, so the
 * `${account}:${parentSourceRecordId}` lookup in resolveJobs finds nothing.
 *
 * The fix may live in the adapter (emit a parent job candidate) or the resolver (create the
 * parent row); these tests only pin the resolved result.
 *
 * Fixture: the invented CRM A export in test/fixtures/jobber, with the recurring drain cleaning
 * job edited to the G6 shape (visits COMPLETED, CANCELLED, UPCOMING; job total null), plus the
 * one-off "WH replace" job (two completed visits and one cancelled visit).
 */
import { describe, expect, it } from 'vitest'
import { jobberAdapter } from '../../../src/adapters/jobber.ts'
import { resolveJobs, type ResolvedJob } from '../../../src/resolve/jobs.ts'
import { editJson, loadFixtureFiles, makeCtx, one } from '../adapters/support.ts'

const FILE = 'sources/jobber/maple_leaf_plumbing.json'

/** "WH replace": one-off, visits COMPLETED, COMPLETED, CANCELLED. */
const JOB_WH = 'Z2lkOi8vSm9iYmVyL0pvYi85MDAwMzAx'
const VISITS_WH = [
  'Z2lkOi8vSm9iYmVyL1Zpc2l0LzkwMDA0MDE',
  'Z2lkOi8vSm9iYmVyL1Zpc2l0LzkwMDA0MDI',
  'Z2lkOi8vSm9iYmVyL1Zpc2l0LzkwMDA0MDM',
]
/** Recurring drain cleaning, edited below to visits CANCELLED, COMPLETED, UPCOMING. */
const JOB_RECURRING = 'Z2lkOi8vSm9iYmVyL0pvYi85MDAwMzAz'
const VISIT_CANCELLED = 'Z2lkOi8vSm9iYmVyL1Zpc2l0LzkwMDA0MDY'
const VISIT_COMPLETED = 'Z2lkOi8vSm9iYmVyL1Zpc2l0LzkwMDA0MDU'
const VISIT_UPCOMING = 'Z2lkOi8vSm9iYmVyL1Zpc2l0LzkwMDA0MDc'
const VISITS_RECURRING = [VISIT_CANCELLED, VISIT_COMPLETED, VISIT_UPCOMING]

interface JobberVisit {
  id: string
  visitStatus: string
  endAt: string | null
}
interface JobberJob {
  id: string
  total: unknown
  visits: { nodes: JobberVisit[] }
}
interface JobberDoc {
  data: { jobs: { nodes: JobberJob[] } }
}

/** The fixture with the recurring job in the G6 shape: COMPLETED, CANCELLED, UPCOMING; total null. */
function g6Files() {
  return editJson(loadFixtureFiles('jobber'), FILE, (raw) => {
    const doc = raw as JobberDoc
    const recurring = one(doc.data.jobs.nodes, (job) => job.id === JOB_RECURRING)
    recurring.total = null
    const overdue = one(recurring.visits.nodes, (visit) => visit.id === VISIT_CANCELLED)
    overdue.visitStatus = 'CANCELLED'
    overdue.endAt = '2026-10-03T15:00:00Z'
  })
}

function resolved(): ResolvedJob[] {
  const batch = jobberAdapter.parse(g6Files(), makeCtx())
  const providerIdByKey = new Map(batch.providers.map((p) => [p.providerKey, 'prov-maple']))
  const propertyIdByKey = new Map(
    batch.properties.map((p) => [p.propertyKey, `home:${p.propertyKey}`]),
  )
  return resolveJobs({ jobs: batch.jobs, calendarBlocks: [], providerIdByKey, propertyIdByKey })
    .jobs
}

function sourceIdsOf(job: ResolvedJob): string[] {
  return job.links.map((link) => link.ref.sourceRecordId)
}

function rowOf(jobs: readonly ResolvedJob[], sourceRecordId: string): ResolvedJob {
  return one(jobs, (job) => sourceIdsOf(job).includes(sourceRecordId))
}

/** Q1-style count: completed work, estimates excluded, visits of one job counted once. */
function completedServices(jobs: readonly ResolvedJob[]): Set<string> {
  return new Set(
    jobs
      .filter((job) => job.status === 'completed' && job.kind !== 'estimate')
      .map((job) => job.parentJobId ?? job.id),
  )
}

describe('G6: CRM A visits resolve under one canonical parent job', () => {
  it('gives the recurring job one parent row and three visit rows linked to it', () => {
    const jobs = resolved()
    const parent = rowOf(jobs, JOB_RECURRING)
    expect(parent.kind).toBe('job')
    expect(parent.parentJobId).toBeNull()

    const visits = jobs.filter((job) => job.parentJobId === parent.id)
    expect(visits).toHaveLength(3)
    expect(visits.flatMap(sourceIdsOf).sort()).toEqual([...VISITS_RECURRING].sort())
    visits.forEach((visit) => {
      expect(visit.kind).toBe('visit')
      expect(visit.providerId).toBe(parent.providerId)
    })
  })

  it('gives the one-off job with three visits one parent row and three linked visits', () => {
    const jobs = resolved()
    const parent = rowOf(jobs, JOB_WH)
    expect(parent.kind).toBe('job')
    const visits = jobs.filter((job) => job.parentJobId === parent.id)
    expect(visits.flatMap(sourceIdsOf).sort()).toEqual([...VISITS_WH].sort())
  })

  it('keeps the visit statuses and takes money from the visits, not the null job total', () => {
    const jobs = resolved()
    const parent = rowOf(jobs, JOB_RECURRING)
    expect(parent.amountCents).toBeNull()
    expect(rowOf(jobs, VISIT_COMPLETED)).toMatchObject({
      status: 'completed',
      amountCents: 9500,
      parentJobId: parent.id,
    })
    expect(rowOf(jobs, VISIT_CANCELLED)).toMatchObject({
      status: 'cancelled',
      parentJobId: parent.id,
    })
    expect(rowOf(jobs, VISIT_UPCOMING)).toMatchObject({
      status: 'scheduled',
      parentJobId: parent.id,
    })
  })

  it('books time only on the upcoming visit, not on the parent row', () => {
    const jobs = resolved()
    const parent = rowOf(jobs, JOB_RECURRING)
    expect(parent.startAt).toBeNull()
    expect(parent.endAt).toBeNull()
    const booked = jobs.filter(
      (job) =>
        (job.id === parent.id || job.parentJobId === parent.id) &&
        job.status === 'scheduled' &&
        job.startAt !== null,
    )
    expect(booked.flatMap(sourceIdsOf)).toEqual([VISIT_UPCOMING])
  })

  it('never generates a visit beyond the listed ones (the rule text is not expanded)', () => {
    const jobs = resolved()
    const parent = rowOf(jobs, JOB_RECURRING)
    const family = jobs.filter((job) => job.id === parent.id || job.parentJobId === parent.id)
    expect(family).toHaveLength(4)
  })

  it('counts each job once in Q1-style history, however many visits completed', () => {
    const jobs = resolved()
    const services = completedServices(jobs)
    const whParent = rowOf(jobs, JOB_WH)
    const recurringParent = rowOf(jobs, JOB_RECURRING)
    expect(services.has(whParent.id)).toBe(true)
    expect(services.has(recurringParent.id)).toBe(true)
    // Two completed WH visits and one completed drain visit are two services, not three.
    const familyOf = (id: string) => [
      id,
      ...jobs.filter((job) => job.parentJobId === id).map((job) => job.id),
    ]
    const fromTheseJobs = [...services].filter((id) =>
      [...familyOf(whParent.id), ...familyOf(recurringParent.id)].includes(id),
    )
    expect(fromTheseJobs).toHaveLength(2)
  })
})
