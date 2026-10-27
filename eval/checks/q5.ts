import {
  emptyResult,
  findArray,
  localDate,
  matchByName,
  providerNameOf,
  startOf,
  statusOf,
  toLocal,
  type CheckResult,
  type Json,
} from './common.ts'

interface Entry {
  provider: string
  aliases: string[]
  date: string
}

export interface Q5Expected {
  services: Entry[]
  labelled: (Entry & { status: 'cancelled' | 'upcoming' })[]
  mustNotAppear: { provider: string; reason: string }[]
}

const namesOf = (e: Entry) => [e.provider, ...e.aliases]

export function checkQ5(payload: Json, expected: Q5Expected): CheckResult {
  const result = emptyResult()
  const items = findArray(
    payload,
    (el) => providerNameOf(el) !== undefined && startOf(el) !== undefined,
  )
  if (items === undefined) {
    result.failures.push(
      'no service records found (expected an array of { provider, start, status, sources })',
    )
    return result
  }
  const seen = new Map<Entry, number>()
  const providerNames = new Map<string, Set<string>>()

  items.forEach((item) => {
    const name = providerNameOf(item) ?? ''
    const start = toLocal(startOf(item) ?? '')
    if (start === undefined) {
      result.failures.push(`"${name}": start is not an ISO date-time`)
      return
    }
    const date = localDate(start)
    const label = `${name} ${date}`
    const banned = matchByName(name, expected.mustNotAppear, (m) => [m.provider])
    if (banned !== undefined) {
      result.failures.push(`${label} must not appear: ${banned.reason}`)
      return
    }
    const status = statusOf(item)
    const service = expected.services.find(
      (s) => s.date === date && matchByName(name, [s], namesOf) !== undefined,
    )
    if (service !== undefined) {
      seen.set(service, (seen.get(service) ?? 0) + 1)
      const names = providerNames.get(service.provider) ?? new Set<string>()
      providerNames.set(service.provider, names.add(name))
      if (status !== undefined && status !== 'completed') {
        result.failures.push(`${label} should be completed, got status "${status}"`)
      }
      return
    }
    const labelled = expected.labelled.find(
      (l) => l.date === date && matchByName(name, [l], namesOf) !== undefined,
    )
    if (labelled === undefined) {
      result.failures.push(`unexpected record ${label}`)
      return
    }
    if (labelled.status === 'cancelled' && status?.startsWith('cancel') !== true) {
      result.failures.push(`${label} must be labelled cancelled, got "${status ?? '(no status)'}"`)
    }
    if (labelled.status === 'upcoming' && (status === undefined || status === 'completed')) {
      result.failures.push(`${label} must be labelled upcoming, got "${status ?? '(no status)'}"`)
    }
  })

  expected.services.forEach((s) => {
    const count = seen.get(s) ?? 0
    if (count === 0) result.failures.push(`missing service ${s.provider} ${s.date}`)
    if (count > 1) result.notes.push(`minor: ${s.provider} ${s.date} listed ${String(count)} times`)
  })
  providerNames.forEach((names, provider) => {
    if (names.size > 1) {
      result.notes.push(
        `minor: ${provider} shown under ${String(names.size)} names (${[...names].join(', ')})`,
      )
    }
  })
  return result
}
