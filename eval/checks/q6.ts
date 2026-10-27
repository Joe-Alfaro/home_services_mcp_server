import {
  confidenceOf,
  emptyResult,
  findArray,
  hasValidSources,
  isObject,
  isValidConfidence,
  matchByName,
  providerNameOf,
  walk,
  type CheckResult,
  type Json,
  type JsonObject,
} from './common.ts'

interface Candidate {
  name: string
  aliases: string[]
  mustInclude: boolean
  maxRank?: number
  notFirst?: boolean
  mustSayNoWaterHeaterHistory?: boolean
}

export interface Q6Expected {
  candidates: Candidate[]
  mustNotAppear: { name: string; reason: string }[]
}

const namesOf = (c: Candidate) => [c.name, ...c.aliases]
const NO_WATER_HEATER_HISTORY = /no water[- ]heater (?:history|jobs|work|experience)/i

function hasConfidence(entry: JsonObject): boolean {
  let found = false
  walk(entry, (value) => {
    if (found) return false
    if (isObject(value) && isValidConfidence(confidenceOf(value))) found = true
    return !found
  })
  return found
}

function mentions(entry: JsonObject, pattern: RegExp): boolean {
  let found = false
  walk(entry, (value) => {
    if (typeof value === 'string' && pattern.test(value)) found = true
    return !found
  })
  return found
}

function checkEntryShape(entry: JsonObject, name: string, result: CheckResult): void {
  const factors = entry.factors
  if (!Array.isArray(factors) || factors.length === 0) {
    result.failures.push(`${name}: no factors`)
    return
  }
  factors.forEach((f, i) => {
    if (!isObject(f) || !hasValidSources(f)) {
      const label = isObject(f) && typeof f.name === 'string' ? f.name : `#${String(i)}`
      result.failures.push(`${name}: factor ${label} cites no sources`)
    }
  })
  if (!hasConfidence(entry)) {
    result.failures.push(`${name}: no availability confidence (high/medium/low)`)
  }
}

export function checkQ6(payload: Json, expected: Q6Expected): CheckResult {
  const result = emptyResult()
  const ranking = findArray(
    payload,
    (el) => providerNameOf(el) !== undefined && typeof el.score === 'number' && 'factors' in el,
  )
  if (ranking === undefined) {
    result.failures.push(
      'no ranking found (expected an ordered array of { name, score, factors, sources })',
    )
    return result
  }
  const positions = new Map<Candidate, number[]>()

  ranking.forEach((entry, index) => {
    const name = providerNameOf(entry) ?? ''
    const rank = index + 1
    const banned = matchByName(name, expected.mustNotAppear, (m) => [m.name])
    if (banned !== undefined) {
      result.failures.push(`"${name}" must not be ranked: ${banned.reason}`)
      return
    }
    const candidate = matchByName(name, expected.candidates, namesOf)
    if (candidate === undefined) {
      result.failures.push(`unexpected candidate "${name}"`)
      return
    }
    positions.set(candidate, [...(positions.get(candidate) ?? []), rank])
    checkEntryShape(entry, candidate.name, result)
    if (typeof entry.rank === 'number' && entry.rank !== rank) {
      result.failures.push(
        `${candidate.name}: rank field ${String(entry.rank)} but position ${String(rank)}`,
      )
    }
    const prev = ranking[index - 1]
    if (
      prev !== undefined &&
      typeof prev.score === 'number' &&
      (entry.score as number) > prev.score
    ) {
      result.failures.push(
        `not ordered by score: ${candidate.name} (${JSON.stringify(entry.score)}) is below a lower score (${String(prev.score)})`,
      )
    }
    if (
      candidate.mustSayNoWaterHeaterHistory === true &&
      !mentions(entry, NO_WATER_HEATER_HISTORY)
    ) {
      result.failures.push(`${candidate.name}: must be marked "no water-heater history"`)
    }
  })

  expected.candidates.forEach((c) => {
    const ranks = positions.get(c) ?? []
    const first = ranks[0]
    if (ranks.length > 1) result.failures.push(`${c.name} ranked ${String(ranks.length)} times`)
    if (first === undefined) {
      if (c.mustInclude) result.failures.push(`ranking is incomplete: ${c.name} missing`)
      return
    }
    if (c.maxRank !== undefined && first > c.maxRank) {
      result.failures.push(
        `${c.name} must be in the top ${String(c.maxRank)}, is #${String(first)}`,
      )
    }
    if (c.notFirst === true && first === 1) result.failures.push(`${c.name} must not rank first`)
  })
  result.notes.push(
    `ranking: ${ranking.map((e, i) => `#${String(i + 1)} ${providerNameOf(e) ?? '?'} (${JSON.stringify(e.score)})`).join(', ')}`,
  )
  return result
}
