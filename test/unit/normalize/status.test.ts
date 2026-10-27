import { describe, expect, it } from 'vitest'
import type { JobStatus } from '../../../src/adapters/types.ts'
import { applyLimboRule } from '../../../src/normalize/status.ts'

const NOW = '2026-11-02T06:00:00Z'

// R9 (d): a scheduled or in-progress item whose slot ended before "now" is limbo.
describe('applyLimboRule', () => {
  it.each<JobStatus>(['scheduled', 'in_progress'])('turns a past %s item into limbo', (status) => {
    expect(
      applyLimboRule(
        status,
        { startAt: '2026-10-28T15:00:00Z', endAt: '2026-10-28T17:00:00Z' },
        NOW,
      ),
    ).toBe('limbo')
  })

  it('uses the start when there is no end', () => {
    expect(applyLimboRule('scheduled', { startAt: '2026-10-28T15:00:00Z', endAt: null }, NOW)).toBe(
      'limbo',
    )
  })

  it('keeps future and still-running items', () => {
    expect(
      applyLimboRule(
        'scheduled',
        { startAt: '2026-11-03T15:00:00Z', endAt: '2026-11-03T17:00:00Z' },
        NOW,
      ),
    ).toBe('scheduled')
    expect(
      applyLimboRule(
        'in_progress',
        { startAt: '2026-11-02T05:00:00Z', endAt: '2026-11-02T07:00:00Z' },
        NOW,
      ),
    ).toBe('in_progress')
  })

  it('treats an end exactly at now as not yet stale', () => {
    expect(applyLimboRule('scheduled', { startAt: '2026-11-02T05:00:00Z', endAt: NOW }, NOW)).toBe(
      'scheduled',
    )
  })

  it('leaves items with no slot alone', () => {
    expect(applyLimboRule('scheduled', { startAt: null, endAt: null }, NOW)).toBe('scheduled')
  })

  it.each<JobStatus>(['completed', 'cancelled', 'on_hold', 'unscheduled', 'limbo'])(
    'never changes %s',
    (status) => {
      expect(
        applyLimboRule(
          status,
          { startAt: '2026-10-28T15:00:00Z', endAt: '2026-10-28T17:00:00Z' },
          NOW,
        ),
      ).toBe(status)
    },
  )
})
