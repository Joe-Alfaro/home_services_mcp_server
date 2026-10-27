/*
 * G20: free-form profile hours. "24/7 emergency service" is a claim, not a working pattern, so
 * the adapter flags it for the engine; day ranges may wrap past Sunday ("Sun-Thu", "Fri-Mon").
 *
 * Expected API (src/adapters/types.ts):
 *
 *   export interface DeclaredHoursCandidate {
 *     …
 *     // True for "24/7"-style hours (parseDeclaredHours().alwaysOpen). The engine then treats
 *     // the provider as having no reliable declared hours.
 *     alwaysOpen: boolean
 *   }
 */
import { describe, expect, it } from 'vitest'
import { profilesAdapter } from '../../../src/adapters/profiles.ts'
import type { CandidateBatch, DeclaredHoursCandidate } from '../../../src/adapters/types.ts'
import { parseDeclaredHours } from '../../../src/normalize/hours.ts'
import { field } from '../pending.ts'
import { editJson, loadFixtureFiles, makeCtx, one } from './support.ts'

const FILE = 'sources/profiles/providers.json'

interface ProfilesDoc {
  providers: { profile_id: string; hours: unknown }[]
}

/** The fixture with the hours of `profileId` replaced. */
function withHours(profileId: string, hours: unknown) {
  return editJson(loadFixtureFiles('profiles'), FILE, (raw) => {
    const doc = raw as ProfilesDoc
    one(doc.providers, (p) => p.profile_id === profileId).hours = hours
  })
}

function hoursOf(batch: CandidateBatch, profileId: string): DeclaredHoursCandidate {
  const provider = one(batch.providers, (p) => p.ref.sourceRecordId === profileId)
  return one(batch.declaredHours, (h) => h.providerKey === provider.providerKey)
}

function days(weekdays: readonly (1 | 2 | 3 | 4 | 5 | 6 | 7)[], start: string, end: string) {
  return weekdays.map((weekday) => ({ weekday, start, end }))
}

describe('G20: 24/7 hours are flagged on the declared-hours candidate', () => {
  it('G20: "24/7 emergency service" → alwaysOpen true', () => {
    const batch = profilesAdapter.parse(withHours('hp_905', '24/7 emergency service'), makeCtx())
    const hours = hoursOf(batch, 'hp_905')

    expect(hours.hoursRaw).toBe('24/7 emergency service')
    expect(field(hours, 'alwaysOpen')).toBe(true)
  })

  it('G20: ordinary declared hours → alwaysOpen false', () => {
    const batch = profilesAdapter.parse(loadFixtureFiles('profiles'), makeCtx())

    batch.declaredHours.forEach((hours) => {
      expect(field(hours, 'alwaysOpen')).toBe(false)
    })
  })
})

describe('G20: day ranges that wrap past Sunday', () => {
  it('G20: "Sun-Thu 8-5" → Sun and Mon-Thu 08:00-17:00', () => {
    const parsed = parseDeclaredHours('Sun-Thu 8-5')

    expect(parsed.parsed).toBe('full')
    expect(parsed.weekly).toEqual(days([1, 2, 3, 4, 7], '08:00', '17:00'))
  })

  it('G20: "Fri-Mon 9am-1pm" → Fri, Sat, Sun, Mon', () => {
    const parsed = parseDeclaredHours('Fri-Mon 9am-1pm')

    expect(parsed.parsed).toBe('full')
    expect(parsed.weekly).toEqual(days([1, 5, 6, 7], '09:00', '13:00'))
  })

  it('G20: a wrapped range in a multi-segment string', () => {
    const parsed = parseDeclaredHours('Sun-Thu 07:00-15:00, Fri 07:00-12:00')

    expect(parsed.parsed).toBe('full')
    expect(parsed.weekly).toEqual([
      ...days([1, 2, 3, 4], '07:00', '15:00'),
      ...days([5], '07:00', '12:00'),
      ...days([7], '07:00', '15:00'),
    ])
  })

  it('G20: the profiles adapter emits the wrapped schedule', () => {
    const batch = profilesAdapter.parse(withHours('hp_905', 'Sun-Thu 8-5'), makeCtx())
    const hours = hoursOf(batch, 'hp_905')

    expect(hours.parsed).toBe('full')
    expect(hours.weekly).toEqual(days([1, 2, 3, 4, 7], '08:00', '17:00'))
  })
})
