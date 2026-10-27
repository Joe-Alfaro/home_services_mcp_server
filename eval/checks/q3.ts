import {
  emptyResult,
  findArray,
  getString,
  localDate,
  localTime,
  matchByName,
  providerNameOf,
  startOf,
  statusOf,
  toLocal,
  type CheckResult,
  type Json,
  type JsonObject,
  type RawWindow,
  windowOf,
} from './common.ts'

export interface Q3Expected {
  window: RawWindow
  rows: { provider: string; aliases: string[]; date: string; time: string; kind: string }[]
  mustNotAppear: { provider: string; date: string; reason: string }[]
}

type Row = Q3Expected['rows'][number]

const namesOf = (r: Row) => [r.provider, ...r.aliases]

/** True when the item is labelled an estimate in its kind, type, label or category. */
export function isEstimate(item: JsonObject): boolean {
  return ['kind', 'type', 'label', 'category'].some((k) => {
    const value = getString(item, [k])
    return value !== undefined && /estimate/i.test(value)
  })
}

export function checkQ3(payload: Json, expected: Q3Expected): CheckResult {
  const result = emptyResult()
  const items = findArray(
    payload,
    (el) => providerNameOf(el) !== undefined && startOf(el) !== undefined,
  )
  if (items === undefined) {
    result.failures.push(
      'no scheduled items found (expected an array of { provider, start, kind, sources })',
    )
    return result
  }
  const window = windowOf(expected.window)
  const seen = new Map<Row, number>()

  items.forEach((item) => {
    const name = providerNameOf(item) ?? ''
    const start = toLocal(startOf(item) ?? '')
    if (start === undefined) {
      result.failures.push(`"${name}": start is not an ISO date-time`)
      return
    }
    const date = localDate(start)
    const label = `${name} ${date} ${localTime(start)}`
    const banned = expected.mustNotAppear.find(
      (m) => m.date === date && matchByName(name, [m], (x) => [x.provider]) !== undefined,
    )
    if (banned !== undefined) {
      result.failures.push(`${label} must not appear: ${banned.reason}`)
      return
    }
    if (start < window.start || start >= window.end) {
      result.failures.push(`${label} is outside the next-14-days window`)
      return
    }
    if (statusOf(item)?.startsWith('cancel') === true) {
      result.failures.push(`${label} is cancelled and must not be listed`)
      return
    }
    const row = expected.rows.find(
      (r) => r.date === date && matchByName(name, [r], namesOf) !== undefined,
    )
    if (row === undefined) {
      result.failures.push(`unexpected item ${label}`)
      return
    }
    seen.set(row, (seen.get(row) ?? 0) + 1)
    if (localTime(start) !== row.time) {
      result.failures.push(`${label}: expected start ${row.time}`)
    }
    if (row.kind === 'estimate' && !isEstimate(item)) {
      result.failures.push(`${label} is an estimate but is not labelled as one`)
    }
    if (row.kind !== 'estimate' && isEstimate(item)) {
      result.failures.push(`${label} is a job but is labelled an estimate`)
    }
  })

  expected.rows.forEach((r) => {
    const count = seen.get(r) ?? 0
    if (count === 0) result.failures.push(`missing ${r.kind} ${r.provider} ${r.date} ${r.time}`)
    if (count > 1) {
      result.failures.push(`${r.provider} ${r.date} listed ${String(count)} times (expected once)`)
    }
  })
  return result
}
