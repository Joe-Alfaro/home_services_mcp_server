import type { Instant, JobStatus } from '../adapters/types.ts'

/**
 * R9 (d), D-032: a scheduled or in-progress item whose slot is over (its end, or its start when
 * it has no end, is before now) becomes limbo. An end exactly at now is not stale.
 */
export function applyLimboRule(
  status: JobStatus,
  slot: { startAt: Instant | null; endAt: Instant | null },
  now: Instant,
): JobStatus {
  if (status !== 'scheduled' && status !== 'in_progress') return status
  const reference = slot.endAt ?? slot.startAt
  if (reference === null) return status
  return Date.parse(reference) < Date.parse(now) ? 'limbo' : status
}
