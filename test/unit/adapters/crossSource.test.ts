import { describe, expect, it } from 'vitest'
import { housecallProAdapter } from '../../../src/adapters/housecallPro.ts'
import { icsAdapter } from '../../../src/adapters/ics.ts'
import { jobberAdapter } from '../../../src/adapters/jobber.ts'
import { workizAdapter } from '../../../src/adapters/workiz.ts'
import { loadFixtureFiles, makeCtx, one, toMs } from './support.ts'

// R12 (c): the same local wall time compares equal whatever basis the source used.
describe('time bases across sources', () => {
  it('an ICS TZID event and a UTC CRM A visit at 09:00 local on 2026-11-03 are the same instant', () => {
    const ctx = makeCtx()
    const visit = one(
      jobberAdapter.parse(loadFixtureFiles('jobber'), ctx).jobs,
      (job) => job.ref.sourceRecordId === 'Z2lkOi8vSm9iYmVyL1Zpc2l0LzkwMDA0MDQ',
    )
    const block = one(icsAdapter.parse(loadFixtureFiles('calendars'), ctx).calendarBlocks, (b) =>
      b.ref.sourceRecordId.startsWith('tzid-job-1@'),
    )
    expect(visit.timeBasis).toBe('utc')
    expect(block.timeBasis).toBe('explicit_zone')
    expect(toMs(visit.startAt)).toBe(toMs(block.startAt))
  })

  it('zone-less CRM B and CRM C times at 09:00 local on 2026-10-31 (CDT) agree with an ICS floating event', () => {
    const ctx = makeCtx()
    const hcp = one(
      housecallProAdapter.parse(loadFixtureFiles('housecall_pro'), ctx).jobs,
      (job) => job.ref.sourceRecordId === 'job_00000000000000000000000000000d01',
    )
    const workiz = one(
      workizAdapter.parse(loadFixtureFiles('workiz'), ctx).jobs,
      (job) => job.ref.sourceRecordId === 'K7P2QX',
    )
    const floating = one(icsAdapter.parse(loadFixtureFiles('calendars'), ctx).calendarBlocks, (b) =>
      b.ref.sourceRecordId.startsWith('floating-est-3@'),
    )
    expect(toMs(hcp.startAt)).toBe(Date.parse('2026-10-31T14:00:00Z'))
    expect(toMs(workiz.startAt)).toBe(toMs(hcp.startAt))
    expect(toMs(floating.startAt)).toBe(toMs(hcp.startAt))
  })
})
