import type { BusyItem } from './engine.ts'

export type Confidence = 'high' | 'medium' | 'low'

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 }

/** The lowest of the given levels; 'high' when none are given. The cautious answer wins (R13). */
export function minConfidence(...levels: Confidence[]): Confidence {
  return levels.reduce<Confidence>(
    (lowest, level) => (RANK[level] < RANK[lowest] ? level : lowest),
    'high',
  )
}

/** `level`, lowered to `cap` when it is above it. */
export function capConfidence(level: Confidence, cap: Confidence): Confidence {
  return minConfidence(level, cap)
}

const LOW_STATUS_REASONS: Partial<Record<BusyItem['status'], string>> = {
  tentative: 'tentative calendar hold (blocks, cautious)',
  limbo: 'limbo status: the source does not say whether this work is still on',
  unscheduled: 'unscheduled item with a start time',
}

/**
 * Confidence of the block a busy item produces, and why it is below 'high'. Tentative events,
 * limbo and unscheduled-with-a-start items are 'low'; everything else keeps its upstream
 * confidence. A missing end adds a default-duration reason.
 */
export function busyItemConfidence(item: BusyItem): { confidence: Confidence; reasons: string[] } {
  const statusReason = LOW_STATUS_REASONS[item.status]
  const reasons = [
    ...(statusReason === undefined ? [] : [statusReason]),
    ...(item.endAt === null ? ['no end time: default duration assumed'] : []),
  ]
  const confidence = statusReason === undefined ? item.confidence : 'low'
  return { confidence, reasons }
}
