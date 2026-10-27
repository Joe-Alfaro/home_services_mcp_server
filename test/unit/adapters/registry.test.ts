import { describe, expect, it } from 'vitest'
import { housecallProAdapter } from '../../../src/adapters/housecallPro.ts'
import { icsAdapter } from '../../../src/adapters/ics.ts'
import { jobberAdapter } from '../../../src/adapters/jobber.ts'
import { profilesAdapter } from '../../../src/adapters/profiles.ts'
import { adapters } from '../../../src/adapters/registry.ts'
import { spreadsheetAdapter } from '../../../src/adapters/spreadsheet.ts'
import type { SourceSystem } from '../../../src/adapters/types.ts'
import { workizAdapter } from '../../../src/adapters/workiz.ts'
import { makeCtx } from './support.ts'

const ALL_SYSTEMS: readonly SourceSystem[] = [
  'jobber',
  'housecall_pro',
  'workiz',
  'spreadsheet',
  'ics',
  'profiles',
]

// R2: one adapter per source behind one contract, registered in one list.
describe('adapter registry', () => {
  it('registers exactly six adapters, one per source system', () => {
    expect(adapters).toHaveLength(6)
    expect(adapters.map((adapter) => adapter.sourceSystem).sort()).toEqual([...ALL_SYSTEMS].sort())
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
