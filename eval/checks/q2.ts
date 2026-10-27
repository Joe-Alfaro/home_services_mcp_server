import {
  emptyResult,
  findArray,
  fmt,
  matchByName,
  minutes,
  overlapMinutes,
  parseInterval,
  providerNameOf,
  readOpenings,
  type CheckResult,
  type Json,
  type RawWindow,
  windowOf,
} from './common.ts'

interface RawInterval {
  start: string
  end: string
}

export interface Q2Expected {
  window: RawWindow
  minMinutes: number
  providers: {
    name: string
    aliases: string[]
    referenceOpenings: RawInterval[]
    busy?: RawInterval[]
  }[]
  mustExclude: { name: string; reason: string }[]
}

type ExpectedProvider = Q2Expected['providers'][number]

const namesOf = (p: ExpectedProvider) => [p.name, ...p.aliases]

export function checkQ2(payload: Json, expected: Q2Expected): CheckResult {
  const result = emptyResult()
  const items = findArray(
    payload,
    (el) => providerNameOf(el) !== undefined && Array.isArray(el.openings),
  )
  if (items === undefined) {
    result.failures.push(
      'no provider list found (expected an array of { name, openings, sources })',
    )
    return result
  }
  const window = windowOf(expected.window)
  const seen = new Map<string, number>()

  items.forEach((item) => {
    const name = providerNameOf(item) ?? ''
    const excluded = matchByName(name, expected.mustExclude, (e) => [e.name])
    if (excluded !== undefined) {
      result.failures.push(`"${name}" must not be listed: ${excluded.reason}`)
      return
    }
    const match = matchByName(name, expected.providers, namesOf)
    if (match === undefined) {
      result.failures.push(`unexpected provider "${name}"`)
      return
    }
    seen.set(match.name, (seen.get(match.name) ?? 0) + 1)
    const { openings, failures } = readOpenings(item.openings, match.name)
    result.failures.push(...failures)

    const outside = openings.filter((o) => o.start < window.start || o.end > window.end)
    outside.forEach((o) => {
      result.failures.push(`${match.name}: opening ${fmt(o)} is outside the next-3-days window`)
    })
    const qualifying = openings.filter(
      (o) => minutes(o) >= expected.minMinutes && !outside.includes(o),
    )
    if (qualifying.length === 0) {
      result.failures.push(
        `${match.name}: no opening of >= ${String(expected.minMinutes)} min in the window`,
      )
    }
    ;(match.busy ?? []).map(parseInterval).forEach((busy) => {
      openings
        .filter((o) => overlapMinutes(o, busy) > 0)
        .forEach((o) => {
          result.failures.push(`${match.name}: opening ${fmt(o)} overlaps busy ${fmt(busy)}`)
        })
    })
    const references = match.referenceOpenings.map(parseInterval)
    const hit = references.some((r) =>
      qualifying.some((o) => overlapMinutes(o, r) >= expected.minMinutes),
    )
    if (!hit) {
      result.notes.push(
        `${match.name}: no returned opening overlaps a reference opening (${references.map(fmt).join('; ')}) by ${String(expected.minMinutes)} min`,
      )
    }
  })

  expected.providers.forEach((p) => {
    const count = seen.get(p.name) ?? 0
    if (count === 0) result.failures.push(`missing provider "${p.name}"`)
    if (count > 1) result.failures.push(`"${p.name}" listed ${String(count)} times`)
  })
  return result
}
