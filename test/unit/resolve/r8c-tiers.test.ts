/*
 * R8 (c): a unit test pins the confidence (and the evidence) of every method tier. The existing
 * resolver tests pin the keyed tiers; these pin the three that were left loose.
 *
 * Expected API:
 *
 *   // src/resolve/providers.ts (exists): CALENDAR_OWNER_CONFIDENCE = 0.8. A calendar_owner link's
 *   // evidence is { matchedOn: 'owner_name', normalizedName: <normalized calendar name> }.
 *
 *   // src/resolve/properties.ts
 *   // fuzzy_street confidence by edit distance to the reference street (D-043).
 *   export const FUZZY_STREET_CONFIDENCE: Readonly<{ oneEdit: number; twoEdits: number }>
 *   //   = { oneEdit: 0.9, twoEdits: 0.8 }
 *   // A fuzzy_street link's evidence adds { editDistance, matchedStreet } to
 *   // { zipInferred, streetMatch: 'fuzzy', reasons }.
 *
 *   // src/resolve/jobs.ts
 *   // A calendar mirror whose text disagrees with the job's (exported; was module-private).
 *   export const MIRROR_TEXT_MISMATCH_CONFIDENCE = 0.6
 *   // Mirror evidence: { minutesApart, textAgrees } for a timed mirror;
 *   // { sameLocalDate, textAgrees } for a date-only row that took the event's time.
 */
import { describe, expect, it } from 'vitest'
import * as jobsModule from '../../../src/resolve/jobs.ts'
import * as propertiesModule from '../../../src/resolve/properties.ts'
import { CALENDAR_OWNER_CONFIDENCE, resolveProviders } from '../../../src/resolve/providers.ts'
import { referenceIndex } from '../normalize/reference.ts'
import { field } from '../pending.ts'
import { address, block, job, property, provider } from './support.ts'

const { resolveJobs } = jobsModule
const { resolveProperties } = propertiesModule

describe('R8 (c): calendar_owner tier', () => {
  const resolution = resolveProviders([
    provider('profiles', 'hp_950', {
      businessName: 'Wren Fix-It Services',
      ownerName: 'Marlo Example',
      phones: ['2145550188'],
      tradesRaw: ['handyman'],
    }),
    provider('ics', 'marlo_example_calendar', { businessName: 'Marlo Example' }),
  ])
  const link = resolution.providers
    .flatMap((p) => p.links)
    .find((l) => l.ref.sourceSystem === 'ics')

  it('R8(c): CALENDAR_OWNER_CONFIDENCE is 0.8', () => {
    expect(CALENDAR_OWNER_CONFIDENCE).toBe(0.8)
  })

  it('R8(c): a calendar joins its owner at 0.8 with the matched name as evidence', () => {
    expect(resolution.providers).toHaveLength(1)
    expect(link).toMatchObject({ method: 'calendar_owner', confidence: 0.8 })
    expect(link?.evidence).toEqual({ matchedOn: 'owner_name', normalizedName: 'marlo example' })
  })
})

describe('R8 (c): fuzzy_street tier', () => {
  const resolution = resolveProperties(
    [
      property(
        'workiz',
        'acme_plumbing',
        'C1',
        address({ line1: '5823 Belmont Ave', zip: '75206' }),
      ),
      // One transposition from the reference street.
      property(
        'jobber',
        'wren_electric',
        'P9',
        address({ line1: '5823 Belomnt Ave', zip: '75206' }),
      ),
    ],
    referenceIndex(),
  )
  const link = resolution.properties
    .flatMap((p) => p.links)
    .find((l) => l.propertyKey === 'jobber:wren_electric:P9')

  it('R8(c): FUZZY_STREET_CONFIDENCE pins one edit at 0.9 and two edits at 0.8', () => {
    expect(field(propertiesModule, 'FUZZY_STREET_CONFIDENCE')).toEqual({
      oneEdit: 0.9,
      twoEdits: 0.8,
    })
  })

  it('R8(c): a one-edit street typo links at exactly 0.9 with the distance and street as evidence', () => {
    expect(link).toMatchObject({ method: 'fuzzy_street', confidence: 0.9 })
    expect(link?.evidence).toMatchObject({
      streetMatch: 'fuzzy',
      zipInferred: false,
      editDistance: 1,
      matchedStreet: 'Belmont Ave',
    })
  })
})

describe('R8 (c): calendar_mirror tiers', () => {
  const PROVIDERS = new Map([
    ['jobber:wren_electric', 'prov-wren'],
    ['ics:wren_calendar', 'prov-wren'],
  ])
  const crmJob = job('jobber', 'wren_electric', 'J7', {
    startAt: '2026-11-12T15:00:00Z',
    endAt: '2026-11-12T17:00:00Z',
    timeBasis: 'utc',
    tradeRaw: 'Install ceiling fan',
  })

  function mirrorOf(summaryRaw: string) {
    const event = block('wren_calendar', 'evt-70', '2026-11-12T15:15:00Z', '2026-11-12T17:00:00Z', {
      summaryRaw,
    })
    const resolution = resolveJobs({
      jobs: [crmJob],
      calendarBlocks: [event],
      providerIdByKey: PROVIDERS,
      propertyIdByKey: new Map(),
    })
    return {
      resolution,
      link: resolution.jobs[0]?.links.find((l) => l.method === 'calendar_mirror'),
    }
  }

  it('R8(c): MIRROR_TEXT_MISMATCH_CONFIDENCE is exported and is 0.6', () => {
    expect(field(jobsModule, 'MIRROR_TEXT_MISMATCH_CONFIDENCE')).toBe(0.6)
  })

  it('R8(c): an agreeing mirror links at 0.8 with minutesApart and textAgrees', () => {
    const { link } = mirrorOf('ceiling fan install')

    expect(link?.confidence).toBe(0.8)
    expect(link?.evidence).toMatchObject({ minutesApart: 15, textAgrees: true })
  })

  it('R8(c): a disagreeing mirror links at 0.6 with textAgrees false', () => {
    const { link, resolution } = mirrorOf('gutter cleaning')

    expect(link?.confidence).toBe(0.6)
    expect(link?.evidence).toMatchObject({ minutesApart: 15, textAgrees: false })
    expect(resolution.mirroredBlocks[0]?.confidence).toBe(0.6)
    expect(resolution.jobs[0]?.confidence).toBe(0.6)
  })
})
