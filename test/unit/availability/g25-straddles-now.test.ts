/*
 * G25: snapshot edges. A synthetic job 2026-11-01 23:00 → 2026-11-02 01:00 local is history
 * (it started before "now", 2026-11-02 00:00 CST) and blocks openings until 01:00. Its status
 * may already be 'completed'; the part after now still blocks. A completed item that lies
 * wholly after now still never blocks (G10, D-022), and one wholly before now is just history.
 */
import { describe, expect, it } from 'vitest'
import { computeAvailability } from '../../../src/availability/engine.ts'
import { NOW, busyItem, historyItem, makeInput, spans } from './support.ts'

/** Mon 00:00-06:00 local (06:00Z-12:00Z on CST). */
const MONDAY_NIGHT = [{ weekday: 1 as const, start: '00:00', end: '06:00' }]
const MONDAY = { from: '2026-11-02T06:00:00Z', to: '2026-11-03T06:00:00Z' }
/** Sun 2026-11-01 23:00 CST → Mon 2026-11-02 01:00 CST. */
const STRADDLE = { start: '2026-11-02T05:00:00Z', end: '2026-11-02T07:00:00Z' }

function mondayWith(status: 'completed' | 'scheduled' | 'in_progress') {
  return computeAvailability(
    makeInput({
      declaredHours: MONDAY_NIGHT,
      history: [historyItem('job-night', STRADDLE.start, STRADDLE.end)],
      busy: [busyItem('job-night', STRADDLE.start, STRADDLE.end, { status })],
      window: MONDAY,
      now: NOW,
    }),
  )
}

describe('G25: a job overlapping "now" blocks the part after now', () => {
  it.each(['completed', 'scheduled', 'in_progress'] as const)(
    'G25: a %s job Sun 23:00 → Mon 01:00 blocks until 01:00',
    (status) => {
      expect(spans(mondayWith(status).openings)).toEqual([
        '2026-11-02T07:00:00Z/2026-11-02T12:00:00Z',
      ])
    },
  )

  it('G25: the completed straddler is reported as a block that cites its source', () => {
    const { blocks } = mondayWith('completed')

    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.sources[0]?.sourceRecordId).toBe('job-night')
  })

  it('G10/G25: a completed job wholly after now still does not block', () => {
    const later = busyItem('job-later', '2026-11-02T08:00:00Z', '2026-11-02T09:00:00Z', {
      status: 'completed',
    })
    const { openings, blocks } = computeAvailability(
      makeInput({ declaredHours: MONDAY_NIGHT, busy: [later], window: MONDAY }),
    )

    expect(spans(openings)).toEqual(['2026-11-02T06:00:00Z/2026-11-02T12:00:00Z'])
    expect(blocks).toEqual([])
  })

  it('G25: a completed job that ended exactly at now does not block', () => {
    const ended = busyItem('job-ended', '2026-11-02T05:00:00Z', NOW, { status: 'completed' })
    const { openings } = computeAvailability(
      makeInput({ declaredHours: MONDAY_NIGHT, busy: [ended], window: MONDAY }),
    )

    expect(spans(openings)).toEqual(['2026-11-02T06:00:00Z/2026-11-02T12:00:00Z'])
  })
})
