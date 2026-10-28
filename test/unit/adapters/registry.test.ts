import { describe, expect, it } from 'vitest'
import { housecallProAdapter } from '../../../src/adapters/housecallPro.ts'
import { icsAdapter } from '../../../src/adapters/ics.ts'
import { jobberAdapter } from '../../../src/adapters/jobber.ts'
import { profilesAdapter } from '../../../src/adapters/profiles.ts'
import { adapters } from '../../../src/adapters/registry.ts'
import { spreadsheetAdapter } from '../../../src/adapters/spreadsheet.ts'
import { SOURCE_TRAITS, type SourceSystem } from '../../../src/adapters/types.ts'
import { workizAdapter } from '../../../src/adapters/workiz.ts'
import { makeCtx } from './support.ts'

// Read live from SOURCE_TRAITS (whose keys the compiler ties to the SourceSystem union), so adding a
// source needs no edit here; the six original systems stay pinned below.
const ALL_SYSTEMS = Object.keys(SOURCE_TRAITS) as SourceSystem[]
const ORIGINAL_SYSTEMS: readonly SourceSystem[] = [
  'jobber',
  'housecall_pro',
  'workiz',
  'spreadsheet',
  'ics',
  'profiles',
]

// R2: one adapter per source behind one contract, registered in one list.
describe('adapter registry', () => {
  it('registers exactly one adapter per source system', () => {
    expect(adapters).toHaveLength(ALL_SYSTEMS.length)
    expect(adapters.map((adapter) => adapter.sourceSystem).sort()).toEqual([...ALL_SYSTEMS].sort())
  })

  it('still lists the six original source systems', () => {
    expect(ALL_SYSTEMS).toEqual(expect.arrayContaining([...ORIGINAL_SYSTEMS]))
  })

  it('registers the adapter modules themselves', () => {
    expect([...adapters]).toEqual(
      expect.arrayContaining([
        jobberAdapter,
        housecallProAdapter,
        workizAdapter,
        spreadsheetAdapter,
        icsAdapter,
        profilesAdapter,
      ]),
    )
  })

  it.each(ALL_SYSTEMS)('%s declares patterns under sources/', (system) => {
    const adapter = adapters.find((candidate) => candidate.sourceSystem === system)
    expect(adapter).toBeDefined()
    expect(adapter?.patterns.length).toBeGreaterThan(0)
    adapter?.patterns.forEach((pattern) => {
      expect(pattern.startsWith('sources/')).toBe(true)
    })
  })

  it.each(ALL_SYSTEMS)('%s returns an empty batch for no files', (system) => {
    const adapter = adapters.find((candidate) => candidate.sourceSystem === system)
    expect(adapter?.parse([], makeCtx())).toEqual({
      providers: [],
      properties: [],
      jobs: [],
      calendarBlocks: [],
      declaredHours: [],
      issues: [],
    })
  })
})
