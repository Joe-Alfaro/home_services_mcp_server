/*
 * G23 (hours half): when a provider's observed bookings fall outside its declared hours, the
 * canonical model records a provider_conflicts row of kind 'hours' with evidence (the declared
 * hours and when the outside work happened) and the source records of that work. Today
 * buildCanonical emits service_area, trade and crm conflicts but never an hours conflict.
 *
 * The crew half of G23 (declared crew 3, observed concurrency 1) is covered in
 * test/unit/availability/engine.test.ts.
 *
 * Fixture (invented): a profile declaring "Mon-Fri 8am-5pm" and a CRM A account sharing its
 * phone. Local times are America/Chicago (CDT until 2026-11-01, CST after).
 *   in hours   Tue 2026-10-20 10:00-12:00 completed
 *   outside    Sat 2026-10-24 10:00-11:00 completed   (not a declared day)
 *   outside    Wed 2026-11-04 17:30-18:30 scheduled   (after 17:00)
 *   ignored    Sun 2026-10-25 09:00-10:00 cancelled   (cancelled work is not work)
 */
import { describe, expect, it } from 'vitest'
import type { DeclaredHoursCandidate } from '../../../src/adapters/types.ts'
import { buildCanonical, recordKeyOf } from '../../../src/ingest/canonical.ts'
import { emptyBatch } from '../../../src/adapters/shared.ts'
import { referenceIndex } from '../normalize/reference.ts'
import { job, provider, ref } from '../resolve/support.ts'

const PHONE = '214-555-0187'

const profile = provider('profiles', 'pf_901', {
  businessName: 'Quillfeather Home Repair',
  phones: [PHONE],
  tradesRaw: ['handyman'],
  crewSize: 1,
})
const account = provider('jobber', 'quillfeather_home_repair', {
  businessName: 'Quillfeather Home Repair',
  phones: [PHONE],
})

const hours: DeclaredHoursCandidate = {
  type: 'declared_hours',
  ref: ref('profiles', 'pf_901', 'pf_901#hours', 'sources/profiles/providers.json'),
  providerKey: profile.providerKey,
  hoursRaw: 'Mon-Fri 8am-5pm',
  weekly: ([1, 2, 3, 4, 5] as const).map((weekday) => ({ weekday, start: '08:00', end: '17:00' })),
  parsed: 'full',
}

function crmJob(id: string, fields: Parameters<typeof job>[3]) {
  return job('jobber', 'quillfeather_home_repair', id, {
    tradeRaw: 'Handyman visit',
    descriptionRaw: 'Handyman visit',
    timeBasis: 'utc',
    ...fields,
  })
}

const IN_HOURS = crmJob('job-qf-in', {
  status: 'completed',
  statusRaw: 'archived',
  startAt: '2026-10-20T15:00:00Z',
  endAt: '2026-10-20T17:00:00Z',
})
const SATURDAY = crmJob('job-qf-sat', {
  status: 'completed',
  statusRaw: 'archived',
  startAt: '2026-10-24T15:00:00Z',
  endAt: '2026-10-24T16:00:00Z',
})
const EVENING = crmJob('job-qf-eve', {
  status: 'scheduled',
  statusRaw: 'upcoming',
  startAt: '2026-11-04T23:30:00Z',
  endAt: '2026-11-05T00:30:00Z',
})
const CANCELLED_SUNDAY = crmJob('job-qf-sun', {
  status: 'cancelled',
  statusRaw: 'cancelled',
  startAt: '2026-10-25T14:00:00Z',
  endAt: '2026-10-25T15:00:00Z',
})

function model(jobs = [IN_HOURS, SATURDAY, EVENING, CANCELLED_SUNDAY]) {
  return buildCanonical(
    [
      { ...emptyBatch(), providers: [profile], declaredHours: [hours] },
      { ...emptyBatch(), providers: [account], jobs },
    ],
    referenceIndex(),
  )
}

/** Typed loosely: 'hours' is not yet a member of ProviderConflictRow['kind']. */
function hoursConflicts(conflicts: ReadonlyArray<{ kind: string }>) {
  return conflicts.filter((conflict) => conflict.kind === 'hours')
}

describe('G23: work outside declared hours is an hours conflict', () => {
  it('resolves the profile and the CRM account to one provider (fixture sanity)', () => {
    expect(model().providers).toHaveLength(1)
  })

  it('records one hours conflict for the provider, citing only the outside bookings', () => {
    const built = model()
    const [only] = built.providers
    const conflicts = hoursConflicts(built.providerConflicts)
    expect(conflicts).toHaveLength(1)
    const [conflict] = built.providerConflicts.filter((c) => hoursConflicts([c]).length === 1)
    expect(conflict?.providerId).toBe(only?.id)
    expect([...(conflict?.records ?? [])].sort()).toEqual(
      [recordKeyOf(SATURDAY.ref, 'job'), recordKeyOf(EVENING.ref, 'job')].sort(),
    )
  })

  it('carries evidence: the declared hours and the local dates of the outside work', () => {
    const [conflict] = model().providerConflicts.filter((c) => hoursConflicts([c]).length === 1)
    const evidence = JSON.stringify(conflict?.detail ?? {})
    expect(evidence).toContain('Mon-Fri 8am-5pm')
    expect(evidence).toContain('2026-10-24')
    expect(evidence).toContain('2026-11-04')
  })

  it('records no hours conflict when every booking is inside declared hours', () => {
    expect(hoursConflicts(model([IN_HOURS, CANCELLED_SUNDAY]).providerConflicts)).toEqual([])
  })
})
