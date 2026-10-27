import {
  emptyResult,
  findKey,
  fmt,
  isObject,
  localDate,
  localInstant,
  namesMatch,
  overlapMinutes,
  parseInterval,
  providerNameOf,
  readOpenings,
  toLocal,
  walk,
  type CheckResult,
  type Interval,
  type Json,
  type JsonObject,
  type Opening,
} from './common.ts'

type Hours = [string, string] | null

export interface Q4Expected {
  providerNames: string[]
  mustNotBe: string[]
  requiredSourceSystems: string[]
  forbiddenSourceSystems: string[]
  trades: string[]
  declaredZips: string[]
  observedZips: Record<string, number>
  history: {
    completed: number
    scheduled: number
    cancelled: number
    limboOrUnscheduled: number
    estimates: number
    tolerance: number
  }
  now: string
  hours: Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', Hours>
  capacity: number
  openingsCount: number
  busy: Record<string, [string, string][]>
  referenceOpenings: { start: string; end: string }[]
}

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
const TRADE_KEYS = new Set(['trades', 'trade', 'declared', 'observed'])

function findObject(payload: Json, predicate: (o: JsonObject) => boolean): JsonObject | undefined {
  let found: JsonObject | undefined
  walk(payload, (value) => {
    if (found !== undefined) return false
    if (isObject(value) && predicate(value)) {
      found = value
      return false
    }
    return true
  })
  return found
}

const ZIP = /^\d{5}$/

/** 5-digit zips anywhere under a value: string values (`["75206"]`, `[{ zip }]`) or object keys (`{ "75206": 148 }`). */
function zipsUnder(value: Json | undefined): Set<string> {
  const zips = new Set<string>()
  if (value === undefined) return zips
  walk(value, (v) => {
    if (typeof v === 'string' && ZIP.test(v)) zips.add(v)
    if (isObject(v)) {
      Object.keys(v)
        .filter((k) => ZIP.test(k))
        .forEach((k) => zips.add(k))
    }
    return true
  })
  return zips
}

function serviceArea(payload: Json): { declared: Set<string>; observed: Set<string> } {
  const area = findObject(payload, (o) => zipsUnder(o.declaredZips ?? o.declared).size > 0)
  if (area === undefined) return { declared: new Set(), observed: new Set() }
  return {
    declared: zipsUnder(area.declaredZips ?? area.declared),
    observed: zipsUnder(area.observedZips ?? area.observed),
  }
}

/** Intervals on one local date when at least `capacity` bookings overlap. */
export function fullCapacityIntervals(
  date: string,
  busy: [string, string][],
  capacity: number,
): Interval[] {
  const events = busy
    .flatMap(([s, e]) => [
      { at: localInstant(date, s), delta: 1 },
      { at: localInstant(date, e), delta: -1 },
    ])
    .sort((a, b) => a.at.toMillis() - b.at.toMillis() || a.delta - b.delta)
  const full: Interval[] = []
  events.reduce((level, event) => {
    const next = level + event.delta
    if (level < capacity && next >= capacity) full.push({ start: event.at, end: event.at })
    if (level >= capacity && next < capacity) {
      const last = full[full.length - 1]
      if (last !== undefined) last.end = event.at
    }
    return next
  }, 0)
  return full.filter((i) => i.end > i.start)
}

function checkHistory(payload: Json, expected: Q4Expected, result: CheckResult): void {
  const history = findObject(
    payload,
    (o) => typeof o.completed === 'number' && typeof o.scheduled === 'number',
  )
  if (history === undefined) {
    result.failures.push(
      'no job history counts found (expected { completed, scheduled, cancelled, … })',
    )
    return
  }
  const tol = expected.history.tolerance
  const compare = (label: string, got: number | undefined, want: number) => {
    if (got === undefined) {
      result.failures.push(`history: no "${label}" count`)
      return
    }
    if (Math.abs(got - want) > tol) {
      result.failures.push(
        `history ${label}: expected ${String(want)} ±${String(tol)}, got ${String(got)}`,
      )
    }
  }
  const num = (k: string) => (typeof history[k] === 'number' ? history[k] : undefined)
  compare('completed', num('completed'), expected.history.completed)
  compare('scheduled', num('scheduled'), expected.history.scheduled)
  compare('cancelled', num('cancelled'), expected.history.cancelled)
  const limbo = num('limbo')
  const unscheduled = num('unscheduled')
  if (limbo !== undefined || unscheduled !== undefined) {
    compare(
      'limbo+unscheduled',
      (limbo ?? 0) + (unscheduled ?? 0),
      expected.history.limboOrUnscheduled,
    )
  }
  if (num('estimates') !== undefined)
    compare('estimates', num('estimates'), expected.history.estimates)
}

function checkOpening(o: Opening, expected: Q4Expected, result: CheckResult): void {
  const label = `opening ${fmt(o)}`
  const weekday = WEEKDAYS[o.start.weekday - 1] ?? 'sun'
  const hours = expected.hours[weekday]
  const date = localDate(o.start)
  if (hours === null) {
    result.failures.push(`${label} is on a closed day (${weekday})`)
    return
  }
  if (o.start < localInstant(date, hours[0]) || o.end > localInstant(date, hours[1])) {
    result.failures.push(`${label} is outside declared hours ${hours[0]}-${hours[1]}`)
  }
  const busy = expected.busy[date]
  if (busy === undefined) return
  fullCapacityIntervals(date, busy, expected.capacity)
    .filter((full) => overlapMinutes(o, full) > 0)
    .forEach((full) => {
      result.failures.push(
        `${label} overlaps ${fmt(full)} when all ${String(expected.capacity)} crew are booked`,
      )
    })
  const usesFreeLane = busy.some(
    ([s, e]) => overlapMinutes(o, { start: localInstant(date, s), end: localInstant(date, e) }) > 0,
  )
  if (usesFreeLane && o.confidence === 'high') {
    result.failures.push(
      `${label} relies on a free crew lane, so confidence must be at most medium (D-041)`,
    )
  }
}

function checkOpenings(payload: Json, expected: Q4Expected, result: CheckResult): void {
  const { openings, failures } = readOpenings(findKey(payload, ['openings']), 'openings')
  result.failures.push(...failures)
  if (openings.length !== expected.openingsCount) {
    result.failures.push(
      `expected ${String(expected.openingsCount)} openings, got ${String(openings.length)}`,
    )
  }
  const now = toLocal(expected.now)
  openings.forEach((o, i) => {
    if (now !== undefined && o.start < now)
      result.failures.push(`opening ${fmt(o)} starts before now`)
    const prev = openings[i - 1]
    if (prev !== undefined && o.start < prev.start)
      result.failures.push(`openings are not in time order at ${fmt(o)}`)
    checkOpening(o, expected, result)
  })
  const refs = expected.referenceOpenings.map(parseInterval)
  const same = refs.every((r, i) => {
    const o = openings[i]
    return o !== undefined && +o.start === +r.start && +o.end === +r.end
  })
  if (!same) {
    result.notes.push(
      `openings differ from the reference (${refs.map(fmt).join('; ')}): got ${openings.map(fmt).join('; ')}`,
    )
  }
}

export function checkQ4(payload: Json, expected: Q4Expected): CheckResult {
  const result = emptyResult()
  if (!isObject(payload)) {
    result.failures.push('expected one provider object')
    return result
  }
  const name = providerNameOf(payload)
  if (name === undefined || !namesMatch(name, expected.providerNames)) {
    result.failures.push(
      `resolved to "${name ?? '(no name)'}", expected ${expected.providerNames[0] ?? ''}`,
    )
  }
  if (name !== undefined && namesMatch(name, expected.mustNotBe)) {
    result.failures.push(`resolved to the wrong business "${name}"`)
  }
  const systems = Array.isArray(payload.sources)
    ? payload.sources
        .filter(isObject)
        .map((s) => (typeof s.sourceSystem === 'string' ? s.sourceSystem.toLowerCase() : ''))
    : []
  expected.requiredSourceSystems.forEach((sys) => {
    if (!systems.some((s) => s.includes(sys)))
      result.failures.push(`top-level sources do not include ${sys}`)
  })
  expected.forbiddenSourceSystems.forEach((sys) => {
    if (systems.some((s) => s.includes(sys))) {
      result.failures.push(`top-level sources include ${sys} records (another business merged in?)`)
    }
  })

  const trades = findKey(payload, ['trades'])
  const tradeNames = new Set<string>()
  walk(trades ?? null, (v, _p, key) => {
    if (typeof v === 'string' && TRADE_KEYS.has(key ?? 'trades')) tradeNames.add(v.toLowerCase())
    return true
  })
  expected.trades.forEach((t) => {
    if (!tradeNames.has(t)) result.failures.push(`trades do not include ${t}`)
  })

  const area = serviceArea(payload)
  const declared = [...area.declared].sort()
  if (declared.join(',') !== [...expected.declaredZips].sort().join(',')) {
    result.failures.push(
      `declared zips: expected ${expected.declaredZips.join(', ')}, got ${declared.join(', ') || '(none)'}`,
    )
  }
  const missingObserved = Object.keys(expected.observedZips).filter((z) => !area.observed.has(z))
  if (missingObserved.length > 0) {
    result.failures.push(`observed zips missing ${missingObserved.join(', ')}`)
  }

  checkHistory(payload, expected, result)
  checkOpenings(payload, expected, result)
  return result
}
