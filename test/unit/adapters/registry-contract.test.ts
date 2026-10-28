import { describe, expect, it } from 'vitest'
import { adapters } from '../../../src/adapters/registry.ts'
import { SOURCE_TRAITS, type CandidateBatch } from '../../../src/adapters/types.ts'
import { makeCtx } from './support.ts'

// Contract guard driven by the registry itself, so a newly registered adapter is checked with no
// test edits. SOURCE_TRAITS is a Record<SourceSystem, ...>, so the compiler forces its keys to be
// exactly the SourceSystem union; its keys stand in for the union at run time.
const BATCH_KEYS: readonly (keyof CandidateBatch)[] = [
  'providers',
  'properties',
  'jobs',
  'calendarBlocks',
  'declaredHours',
  'issues',
]
const CANDIDATE_KEYS = BATCH_KEYS.filter((key) => key !== 'issues')
const UNION_MEMBERS = Object.keys(SOURCE_TRAITS).sort()

describe('adapter registry contract', () => {
  it('registers exactly one adapter per SourceSystem union member', () => {
    const systems = adapters.map((adapter) => adapter.sourceSystem)
    expect(new Set(systems).size).toBe(systems.length)
    expect([...systems].sort()).toEqual(UNION_MEMBERS)
  })

  describe.each(adapters.map((adapter) => [adapter.sourceSystem, adapter] as const))(
    '%s',
    (system, adapter) => {
      it('has a SOURCE_TRAITS entry', () => {
        expect(Object.hasOwn(SOURCE_TRAITS, system)).toBe(true)
      })

      it('returns an empty, contract-shaped batch for no files', () => {
        const batch = adapter.parse([], makeCtx())
        expect(Object.keys(batch).sort()).toEqual([...BATCH_KEYS].sort())
        CANDIDATE_KEYS.forEach((key) => {
          expect(batch[key], key).toEqual([])
        })
        expect(Array.isArray(batch.issues)).toBe(true)
        batch.issues.forEach((issue) => {
          expect(issue.severity).toBe('info')
        })
      })
    },
  )
})
