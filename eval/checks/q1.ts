import {
  collectStrings,
  emptyResult,
  findArray,
  getNumber,
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

function recallNote(payload: Json, expected: Q1Expected): string {
  const cited = collectStrings(payload)
    .filter(({ path }) => path.endsWith('.sourceRecordId'))
    .map(({ value }) => value)
  const cores = Object.values(expected.jobIds)
    .flat()
    .map(idCore)
    .filter((c): c is string => c !== undefined)
  const found = cores.filter((core) => cited.some((id) => id.includes(core))).length
  return `job ID recall (non-CSV, informational): ${String(found)}/${String(cores.length)} expected jobs cited in sources`
}

export function checkQ1(payload: Json, expected: Q1Expected): CheckResult {
  const result = emptyResult()
  const groups = findArray(payload, isTradeGroup)
  if (groups === undefined) {
    result.failures.push('no trade groups found (expected an array of { trade, count, sources })')
    return result
  }
  const counts = new Map<string, number>()
  groups.forEach((g) => {
    const trade = typeof g.trade === 'string' ? g.trade.toLowerCase() : ''
    if (counts.has(trade)) result.failures.push(`trade "${trade}" listed more than once`)
    counts.set(trade, (counts.get(trade) ?? 0) + (getNumber(g, COUNT_KEYS) ?? 0))
  })

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
  result.notes.push(`total ${String(total)} (expected ${String(expected.total)})`)
  result.notes.push(recallNote(payload, expected))
  return result
}
