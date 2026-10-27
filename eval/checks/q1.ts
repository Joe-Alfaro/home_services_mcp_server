import {
  collectStrings,
  emptyResult,
  findArray,
  getNumber,
  isObject,
  type CheckResult,
  type Json,
  type JsonObject,
} from './common.ts'

export interface Q1Expected {
  trades: Record<string, { count: number; min: number; max: number }>
  total: number
  splitTolerance: { trades: [string, string]; combinedMin: number; combinedMax: number }
  jobIds: Record<string, string[]>
}

const COUNT_KEYS = ['count', 'jobCount', 'jobs', 'total']

function isTradeGroup(el: JsonObject): boolean {
  return typeof el.trade === 'string' && getNumber(el, COUNT_KEYS) !== undefined
}

function inRange(value: number, range: { min: number; max: number }): boolean {
  return value >= range.min && value <= range.max
}

/** Core of an expected job ID ("hcp:job_ab12" → "job_ab12"); CSV IDs are skipped (row numbering is the implementation's). */
function idCore(id: string): string | undefined {
  if (id.startsWith('csv:')) return undefined
  return id.slice(id.indexOf(':') + 1)
}

/** The sourceRecordIds an item cites anywhere inside it. */
function citedIds(item: JsonObject): string[] {
  return collectStrings(item)
    .filter(({ path }) => path.endsWith('.sourceRecordId'))
    .map(({ value }) => value)
}

/** Per-trade counts of the summary groups; duplicate trades are failures. */
function summaryCounts(payload: Json, result: CheckResult): Map<string, number> | undefined {
  const groups = findArray(payload, isTradeGroup)
  if (groups === undefined) {
    result.failures.push('no trade groups found (expected an array of { trade, count, sources })')
    return undefined
  }
  const counts = new Map<string, number>()
  groups.forEach((g) => {
    const trade = typeof g.trade === 'string' ? g.trade.toLowerCase() : ''
    if (counts.has(trade)) result.failures.push(`trade "${trade}" listed more than once`)
    counts.set(trade, (counts.get(trade) ?? 0) + (getNumber(g, COUNT_KEYS) ?? 0))
  })
  return counts
}

/**
 * Q1 pass/fail from the summary alone: the per-trade counts (and `total`, when given, must be
 * their sum). The job list is checked page by page in checkQ1Pages.
 */
export function checkQ1(payload: Json, expected: Q1Expected): CheckResult {
  const result = emptyResult()
  const counts = summaryCounts(payload, result)
  if (counts === undefined) return result

  const [splitA, splitB] = expected.splitTolerance.trades
  const combined = (counts.get(splitA) ?? 0) + (counts.get(splitB) ?? 0)
  const splitOk =
    combined >= expected.splitTolerance.combinedMin &&
    combined <= expected.splitTolerance.combinedMax
  Object.entries(expected.trades).forEach(([trade, range]) => {
    const got = counts.get(trade) ?? 0
    if (inRange(got, range)) return
    if ((trade === splitA || trade === splitB) && splitOk) {
      result.notes.push(
        `${trade} ${String(got)} outside [${String(range.min)}, ${String(range.max)}] but ${splitA}+${splitB} = ${String(combined)} is accepted (two-trade provider split)`,
      )
      return
    }
    result.failures.push(
      `${trade}: expected ${String(range.count)} (accepted ${String(range.min)}-${String(range.max)}), got ${String(got)}`,
    )
  })
  counts.forEach((got, trade) => {
    if (!(trade in expected.trades) && got > 0) {
      result.failures.push(`unexpected trade "${trade}" with ${String(got)} jobs`)
    }
  })
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  if (isObject(payload) && typeof payload.total === 'number' && payload.total !== total) {
    result.failures.push(
      `total ${String(payload.total)} is not the sum of the trade counts (${String(total)})`,
    )
  }
  result.notes.push(`total ${String(total)} (expected ${String(expected.total)})`)
  return result
}

/**
 * Q1's paged job list, read to the end: one item per counted job (as many as the summary counts,
 * trade by trade), and every expected non-CSV job ID cited by exactly one item (recall 100%, no
 * duplicates).
 */
export function checkQ1Pages(
  payload: Json,
  items: JsonObject[],
  expected: Q1Expected,
): CheckResult {
  const result = emptyResult()
  const counts = summaryCounts(payload, emptyResult()) ?? new Map<string, number>()
  const summaryTotal = [...counts.values()].reduce((a, b) => a + b, 0)
  if (items.length !== summaryTotal) {
    result.failures.push(
      `paged job list has ${String(items.length)} jobs but the trade counts add up to ${String(summaryTotal)}`,
    )
  }
  const listed = items.reduce((map, item) => {
    const trade = typeof item.trade === 'string' ? item.trade.toLowerCase() : '(no trade)'
    return map.set(trade, (map.get(trade) ?? 0) + 1)
  }, new Map<string, number>())
  ;[...new Set([...counts.keys(), ...listed.keys()])].sort().forEach((trade) => {
    const want = counts.get(trade) ?? 0
    const got = listed.get(trade) ?? 0
    if (want !== got) {
      result.failures.push(
        `paged job list has ${String(got)} ${trade} jobs but the summary counts ${String(want)}`,
      )
    }
  })

  const cited = items.map(citedIds)
  const cores = Object.values(expected.jobIds)
    .flat()
    .map(idCore)
    .filter((c): c is string => c !== undefined)
  const hits = cores.map((core) => ({
    core,
    items: cited.filter((ids) => ids.some((id) => id.includes(core))).length,
  }))
  const missing = hits.filter((h) => h.items === 0).map((h) => h.core)
  const repeated = hits.filter((h) => h.items > 1).map((h) => h.core)
  const found = cores.length - missing.length
  const recall = `job ID recall (non-CSV): ${String(found)}/${String(cores.length)} expected jobs cited in the paged job list`
  if (missing.length > 0) {
    result.failures.push(`${recall}; missing e.g. ${missing.slice(0, 3).join(', ')}`)
  } else {
    result.notes.push(recall)
  }
  if (repeated.length > 0) {
    result.failures.push(
      `${String(repeated.length)} expected jobs appear on more than one paged item, e.g. ${repeated.slice(0, 3).join(', ')}`,
    )
  }
  return result
}
