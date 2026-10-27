/*
 * Expected API of src/availability/confidence.ts (pure):
 *
 *   import type { BusyItem } from './engine.ts'
 *
 *   export type Confidence = 'high' | 'medium' | 'low'
 *
 *   // The lowest of the given levels; 'high' when none are given.
 *   export function minConfidence(...levels: Confidence[]): Confidence
 *   // `level`, lowered to `cap` when it is above it.
 *   export function capConfidence(level: Confidence, cap: Confidence): Confidence
 *   // Confidence of the block a busy item produces, and why it is below 'high':
 *   //   scheduled / in_progress / on_hold jobs, visits, estimates and confirmed events → the item's
 *   //   own confidence; tentative events, limbo and unscheduled-with-a-start → 'low' with a reason
 *   //   naming the status; a missing end adds a "no end / default duration" reason.
 *   export function busyItemConfidence(item: BusyItem): { confidence: Confidence; reasons: string[] }
 */
import { describe, expect, it } from 'vitest'
import {
  busyItemConfidence,
  capConfidence,
  minConfidence,
} from '../../../src/availability/confidence.ts'
import { busyItem, calendarBlock, ref } from './support.ts'

const START = '2026-11-02T16:00:00Z'
const END = '2026-11-02T18:00:00Z'

describe('minConfidence / capConfidence', () => {
  it('R13: the cautious (lowest) level wins', () => {
    expect(minConfidence()).toBe('high')
    expect(minConfidence('high', 'high')).toBe('high')
    expect(minConfidence('high', 'medium')).toBe('medium')
    expect(minConfidence('medium', 'low', 'high')).toBe('low')
  })

  it('D-041: capping at medium lowers high and leaves medium and low alone', () => {
    expect(capConfidence('high', 'medium')).toBe('medium')
    expect(capConfidence('medium', 'medium')).toBe('medium')
    expect(capConfidence('low', 'medium')).toBe('low')
    expect(capConfidence('high', 'high')).toBe('high')
  })
})

describe('busyItemConfidence', () => {
  it.each([
    ['scheduled job', busyItem('x', START, END)],
    ['in-progress job', busyItem('x', START, END, { status: 'in_progress' })],
    ['scheduled estimate (G4)', busyItem('x', START, END, { kind: 'estimate' })],
    ['scheduled visit (G6)', busyItem('x', START, END, { kind: 'visit' })],
    ['confirmed calendar event', calendarBlock('x', START, END)],
  ])('D-041: a %s with both ends is high with no reasons', (_label, item) => {
    expect(busyItemConfidence(item)).toEqual({ confidence: 'high', reasons: [] })
  })

  it.each([
    ['tentative', calendarBlock('x', START, END, { status: 'tentative' }), /tentative/i],
    ['limbo', busyItem('x', START, END, { status: 'limbo' }), /limbo/i],
    ['unscheduled', busyItem('x', START, null, { status: 'unscheduled' }), /unscheduled/i],
  ])('D-041/D-022: a %s item is low with a reason', (_label, item, reason) => {
    const { confidence, reasons } = busyItemConfidence(item)

    expect(confidence).toBe('low')
    expect(reasons).toEqual(expect.arrayContaining([expect.stringMatching(reason)]))
  })

  it('G12: a missing end adds a default-duration reason', () => {
    const { reasons } = busyItemConfidence(busyItem('x', START, null, { status: 'limbo' }))

    expect(reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/limbo/i),
        expect.stringMatching(/no end|default duration/i),
      ]),
    )
  })

  it('G18: an item resolved at low confidence (CSV-only row) stays low', () => {
    const row = busyItem('row:12', START, END, {
      confidence: 'low',
      sources: [ref('row:12', 'spreadsheet')],
    })

    expect(busyItemConfidence(row).confidence).toBe('low')
  })

  it('R13: an item resolved at medium confidence stays medium', () => {
    expect(busyItemConfidence(busyItem('x', START, END, { confidence: 'medium' })).confidence).toBe(
      'medium',
    )
  })
})
