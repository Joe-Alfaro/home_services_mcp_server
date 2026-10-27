/*
 * G5: an approved estimate and the job created from it are one piece of work. The resolver can
 * only merge them if the adapter keeps the link.
 *
 * Expected API (src/adapters/types.ts):
 *
 *   export interface JobCandidate {
 *     …
 *     // CRM B `original_estimate_id`: the sourceRecordId of the estimate this job came from.
 *     // null on a CRM B job without a link; absent or null on estimates and other sources.
 *     originalEstimateRecordId?: string | null
 *   }
 *
 * The M1 job resolver already reads `JobInput.originalEstimateRecordId` (JobInput = JobCandidate
 * & { originalEstimateRecordId?: string | null }), so the adapter field must use this name. The
 * adapter half is being built on the pipeline implementation branch; merge it, don't redo it.
 */
import { describe, expect, it } from 'vitest'
import { housecallProAdapter } from '../../../src/adapters/housecallPro.ts'
import { field } from '../pending.ts'
import { loadFixtureFiles, makeCtx, one } from './support.ts'

/** complete rated, created from EST_UPCOMING (`original_estimate_id` in jobs_page_1.json). */
const JOB_WATER_HEATER = 'job_00000000000000000000000000000d01'
/** `original_estimate_id: null`. */
const JOB_DST_NIGHT = 'job_00000000000000000000000000000d02'
const EST_UPCOMING = 'est_00000000000000000000000000000e02'

function parseFixture() {
  return housecallProAdapter.parse(loadFixtureFiles('housecall_pro'), makeCtx())
}

describe('G5: Housecall Pro jobs keep their original estimate', () => {
  it('G5: a job created from an estimate carries originalEstimateRecordId', () => {
    const job = one(parseFixture().jobs, (j) => j.ref.sourceRecordId === JOB_WATER_HEATER)

    expect(job.kind).toBe('job')
    expect(field(job, 'originalEstimateRecordId')).toBe(EST_UPCOMING)
  })

  it('G5: the linked estimate is still emitted as its own estimate candidate', () => {
    const estimate = one(parseFixture().jobs, (j) => j.ref.sourceRecordId === EST_UPCOMING)

    expect(estimate.kind).toBe('estimate')
  })

  it('G5: a job without a link carries null; estimates carry no link', () => {
    const { jobs } = parseFixture()
    const unlinked = one(jobs, (j) => j.ref.sourceRecordId === JOB_DST_NIGHT)

    expect(field(unlinked, 'originalEstimateRecordId')).toBeNull()
    jobs
      .filter((j) => j.kind === 'estimate')
      .forEach((estimate) => {
        expect(field(estimate, 'originalEstimateRecordId') ?? null).toBeNull()
      })
  })
})
