import { describe, expect, it } from 'vitest'
import { profilesAdapter } from '../../../src/adapters/profiles.ts'
import type { CandidateBatch, DeclaredHoursCandidate } from '../../../src/adapters/types.ts'
import {
  expectProvenance,
  expectUniqueRecordIds,
  loadFixtureFiles,
  makeCtx,
  one,
} from './support.ts'

const FILE = 'sources/profiles/providers.json'

function parseFixture() {
  return profilesAdapter.parse(loadFixtureFiles('profiles'), makeCtx())
}

function hoursOf(batch: CandidateBatch, profileId: string): DeclaredHoursCandidate {
  const provider = one(batch.providers, (p) => p.ref.sourceRecordId === profileId)
  return one(batch.declaredHours, (h) => h.providerKey === provider.providerKey)
}

function weekdays(start: string, end: string) {
  return ([1, 2, 3, 4, 5] as const).map((weekday) => ({ weekday, start, end }))
}

describe('profilesAdapter', () => {
  it('declares its source system and data pack pattern', () => {
    expect(profilesAdapter.sourceSystem).toBe('profiles')
    expect(profilesAdapter.patterns.length).toBeGreaterThan(0)
    profilesAdapter.patterns.forEach((pattern) => {
      expect(pattern.startsWith('sources/profiles/')).toBe(true)
    })
  })

  it('is pure: the same input gives the same output', () => {
    expect(parseFixture()).toEqual(parseFixture())
  })

  describe('provenance (R11)', () => {
    it('stamps every candidate with system, file, profile_id and run time', () => {
      const batch = parseFixture()
      expectProvenance(batch, { sourceSystem: 'profiles', sourceFiles: [FILE] })
      expectUniqueRecordIds(batch)
      expect(batch.providers.map((p) => p.ref.sourceRecordId).sort()).toEqual([
        'hp_901',
        'hp_902',
        'hp_903',
        'hp_904',
        'hp_905',
      ])
    })
  })

  describe('providers', () => {
    it('emits one provider per profile with a distinct provider key', () => {
      const batch = parseFixture()
      expect(batch.providers).toHaveLength(5)
      expect(new Set(batch.providers.map((p) => p.providerKey)).size).toBe(5)
    })

    it('keeps the declared facts as given, for later conflict checks (R4 i, R13)', () => {
      const provider = one(parseFixture().providers, (p) => p.ref.sourceRecordId === 'hp_902')
      expect(provider.businessName).toBe('Tonys Handy Help')
      expect(provider.ownerName).toBe('Tony Ferraro')
      expect(provider.phones).toEqual(['214-555-0199'])
      expect(provider.emails).toEqual(['tony@tonyshandyhelp.example.com'])
      expect(provider.website).toBe('tonyshandyhelp.example.com')
      expect(provider.tradesRaw).toEqual(['handyman', 'painting'])
      expect(provider.doesNotDoRaw).toEqual(['plumbing', 'electrical'])
      expect(provider.declaredServiceZips).toEqual(['75204', '75206', '75214'])
      expect(provider.crewSize).toBe(1)
      expect(provider.declaredCrm).toBe('Google Sheets')
    })

    it('uses null for a missing website', () => {
      const provider = one(parseFixture().providers, (p) => p.ref.sourceRecordId === 'hp_901')
      expect(provider.website).toBeNull()
      expect(provider.declaredCrm).toBe('jobber')
    })
  })

  describe('declared hours', () => {
    it('emits one declared_hours record per profile', () => {
      const batch = parseFixture()
      expect(batch.declaredHours).toHaveLength(5)
      batch.declaredHours.forEach((hours) => {
        expect(hours.ref.sourceFile).toBe(FILE)
      })
    })

    it('parses "Mon-Fri 8am-5pm, Sat 9am-1pm"', () => {
      const hours = hoursOf(parseFixture(), 'hp_901')
      expect(hours.hoursRaw).toBe('Mon-Fri 8am-5pm, Sat 9am-1pm')
      expect(hours.parsed).toBe('full')
      expect(hours.weekly).toEqual([
        ...weekdays('08:00', '17:00'),
        { weekday: 6, start: '09:00', end: '13:00' },
      ])
    })

    it('parses "M-F 8-5" with the end in the afternoon', () => {
      const hours = hoursOf(parseFixture(), 'hp_902')
      expect(hours.parsed).toBe('full')
      expect(hours.weekly).toEqual(weekdays('08:00', '17:00'))
    })

    it('parses the per-day dictionary form, skipping closed days', () => {
      const hours = hoursOf(parseFixture(), 'hp_903')
      expect(hours.parsed).toBe('full')
      expect(hours.weekly).toEqual(weekdays('07:00', '16:00'))
      expect(hours.hoursRaw).not.toBe('')
    })

    it('parses "Weekdays 07:00-18:00 / Saturday 08:00-14:00"', () => {
      const hours = hoursOf(parseFixture(), 'hp_904')
      expect(hours.parsed).toBe('full')
      expect(hours.weekly).toEqual([
        ...weekdays('07:00', '18:00'),
        { weekday: 6, start: '08:00', end: '14:00' },
      ])
    })

    it('keeps unparseable hours as raw text with no windows', () => {
      const hours = hoursOf(parseFixture(), 'hp_905')
      expect(hours.hoursRaw).toBe('by appointment only')
      expect(hours.parsed).toBe('none')
      expect(hours.weekly).toEqual([])
    })
  })

  it('produces no properties, jobs or calendar blocks', () => {
    const batch = parseFixture()
    expect(batch.properties).toEqual([])
    expect(batch.jobs).toEqual([])
    expect(batch.calendarBlocks).toEqual([])
  })
})
