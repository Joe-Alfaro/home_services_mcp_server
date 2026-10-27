import { DateTime } from 'luxon'

export type Json = null | boolean | number | string | Json[] | JsonObject
export interface JsonObject {
  [key: string]: Json
}

export interface CheckResult {
  failures: string[]
  notes: string[]
}

export interface Interval {
  start: DateTime
  end: DateTime
}

export const ZONE = 'America/Chicago'
export const CONFIDENCE_LEVELS = ['high', 'medium', 'low']

// Arrays under these keys are not "response items" for R19: they are provenance itself,
// free-text reasons, names, or availability openings (which carry confidence and reasons, R13).
const SOURCE_EXEMPT_KEYS = new Set(['sources', 'reasons', 'openings', 'aliases'])
const HOUSE_NUMBER_KEYS = new Set(['housenumber', 'streetnumber', 'addressnumber'])
const STREET_SUFFIXES =
  'St|Street|Ave|Avenue|Dr|Drive|Rd|Road|Blvd|Boulevard|Ln|Lane|Pkwy|Parkway|Ct|Court|Pl|Place|Cir|Circle|Trl|Trail'
const ADDRESS_PATTERN = new RegExp(
  `(?<![\\w-])(\\d{1,5})\\s+(?:[A-Za-z][A-Za-z.']*\\s+){1,4}(?:${STREET_SUFFIXES})\\b`,
  'gi',
)
const PHONE_PATTERNS = [
  /(?<![\w.:-])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w-])/g,
  /(?<![\w.:-])(?:\+?1)?\d{10}(?![\w-])/g,
]
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const ISO_DATETIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g
// ICS UIDs look like emails; they are opaque record IDs, not contact details.
const ICS_UID_SUFFIX = /@google\.com$/i

export function emptyResult(): CheckResult {
  return { failures: [], notes: [] }
}

export function merge(...results: CheckResult[]): CheckResult {
  return {
    failures: results.flatMap((r) => r.failures),
    notes: results.flatMap((r) => r.notes),
  }
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function getString(obj: JsonObject, keys: string[]): string | undefined {
  const key = keys.find((k) => typeof obj[k] === 'string' && obj[k] !== '')
  return key === undefined ? undefined : (obj[key] as string)
}

export function getNumber(obj: JsonObject, keys: string[]): number | undefined {
  const key = keys.find((k) => typeof obj[k] === 'number')
  return key === undefined ? undefined : (obj[key] as number)
}

/** Visits every value depth-first with its dotted path and the key that holds it. */
export function walk(
  value: Json,
  visit: (value: Json, path: string, key: string | undefined) => boolean | undefined,
  path = '$',
  key?: string,
): void {
  if (visit(value, path, key) === false) return
  if (Array.isArray(value)) {
    value.forEach((el, i) => {
      walk(el, visit, `${path}[${String(i)}]`, key)
    })
    return
  }
  if (isObject(value)) {
    Object.entries(value).forEach(([k, v]) => {
      walk(v, visit, `${path}.${k}`, k)
    })
  }
}

/** First non-empty array (depth-first) whose every element satisfies the predicate. */
export function findArray(
  payload: Json,
  predicate: (el: JsonObject) => boolean,
): JsonObject[] | undefined {
  let found: JsonObject[] | undefined
  walk(payload, (value) => {
    if (found !== undefined) return false
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((el) => isObject(el) && predicate(el))
    ) {
      found = value as JsonObject[]
      return false
    }
    return true
  })
  return found
}

/** Value of the first key (depth-first) with one of the given names. */
export function findKey(payload: Json, names: string[]): Json | undefined {
  let found: Json | undefined
  walk(payload, (value, _path, key) => {
    if (found !== undefined) return false
    if (key !== undefined && names.includes(key)) {
      found = value
      return false
    }
    return true
  })
  return found
}

export function collectStrings(payload: Json): { path: string; value: string }[] {
  const out: { path: string; value: string }[] = []
  walk(payload, (value, path) => {
    if (typeof value === 'string') out.push({ path, value })
    return true
  })
  return out
}

const NAME_STOP_TOKENS = new Set(['co', 'llc', 'inc', 'the', 'company', 'and'])

/** Business-name key: case, punctuation, '&' and legal suffixes ignored ("Rays Fix It" = "Ray's Fix-It"). */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== '' && !NAME_STOP_TOKENS.has(t))
    .join('')
}

export function namesMatch(candidate: string, names: string[]): boolean {
  const key = normalizeName(candidate)
  return names.some((n) => normalizeName(n) === key)
}

export function matchByName<T>(
  name: string,
  list: T[],
  namesOf: (entry: T) => string[],
): T | undefined {
  return list.find((entry) => namesMatch(name, namesOf(entry)))
}

export interface Opening extends Interval {
  confidence: string | number | undefined
}

/** Reads an `openings` array; malformed entries become failures prefixed with `label`. */
export function readOpenings(
  value: Json | undefined,
  label: string,
): { openings: Opening[]; failures: string[] } {
  if (!Array.isArray(value)) return { openings: [], failures: [`${label}: no openings array`] }
  const failures: string[] = []
  const openings: Opening[] = []
  value.forEach((el, i) => {
    const interval = isObject(el) ? intervalOf(el) : undefined
    if (!isObject(el) || interval === undefined) {
      failures.push(`${label}: opening ${String(i)} has no valid start/end`)
      return
    }
    const confidence = confidenceOf(el)
    if (!isValidConfidence(confidence)) {
      failures.push(`${label}: opening ${fmt(interval)} has no confidence (high/medium/low)`)
    }
    openings.push({ ...interval, confidence })
  })
  return { openings, failures }
}

export function providerNameOf(item: JsonObject): string | undefined {
  const direct = getString(item, ['providerName', 'businessName', 'name'])
  if (direct !== undefined) return direct
  const provider = item.provider
  if (typeof provider === 'string' && provider !== '') return provider
  if (isObject(provider)) return getString(provider, ['name', 'businessName', 'providerName'])
  return undefined
}

export function startOf(item: JsonObject): string | undefined {
  return getString(item, ['start', 'startsAt', 'startTime', 'scheduledStart', 'date'])
}

export function endOf(item: JsonObject): string | undefined {
  return getString(item, ['end', 'endsAt', 'endTime', 'scheduledEnd'])
}

export function statusOf(item: JsonObject): string | undefined {
  return getString(item, ['status', 'state'])?.toLowerCase()
}

export function confidenceOf(item: JsonObject): string | number | undefined {
  const value = item.confidence
  if (typeof value === 'string' || typeof value === 'number') return value
  return undefined
}

export function isValidConfidence(value: string | number | undefined): boolean {
  if (typeof value === 'number') return value >= 0 && value <= 1
  return value !== undefined && CONFIDENCE_LEVELS.includes(value.toLowerCase())
}

/** Parses an ISO string and moves it to America/Chicago; undefined when unparseable. */
export function toLocal(iso: string): DateTime | undefined {
  const parsed = DateTime.fromISO(iso, { setZone: true })
  return parsed.isValid ? parsed.setZone(ZONE) : undefined
}

export function localDate(dt: DateTime): string {
  return dt.toFormat('yyyy-MM-dd')
}

export function localTime(dt: DateTime): string {
  return dt.toFormat('HH:mm')
}

export function intervalOf(item: JsonObject): Interval | undefined {
  const s = startOf(item)
  const e = endOf(item)
  if (s === undefined || e === undefined) return undefined
  const start = toLocal(s)
  const end = toLocal(e)
  if (start === undefined || end === undefined || end <= start) return undefined
  return { start, end }
}

export function minutes(interval: Interval): number {
  return interval.end.diff(interval.start, 'minutes').minutes
}

export function overlapMinutes(a: Interval, b: Interval): number {
  const start = a.start > b.start ? a.start : b.start
  const end = a.end < b.end ? a.end : b.end
  return end > start ? end.diff(start, 'minutes').minutes : 0
}

export function parseInterval(raw: { start: string; end: string }): Interval {
  const start = toLocal(raw.start)
  const end = toLocal(raw.end)
  if (start === undefined || end === undefined) {
    throw new Error(`bad interval in expected file: ${raw.start}..${raw.end}`)
  }
  return { start, end }
}

export interface RawWindow {
  from: string
  to: string
}

export function windowOf(window: RawWindow): Interval {
  return parseInterval({ start: window.from, end: window.to })
}

/** A local date plus HH:mm in America/Chicago. */
export function localInstant(date: string, time: string): DateTime {
  return DateTime.fromISO(`${date}T${time}`, { zone: ZONE })
}

export function fmt(interval: Interval): string {
  return `${interval.start.toFormat('ccc MM-dd HH:mm')}-${interval.end.toFormat('HH:mm')}`
}

export function hasValidSources(item: JsonObject): boolean {
  const sources = item.sources
  return (
    Array.isArray(sources) &&
    sources.length > 0 &&
    sources.every(
      (s) =>
        isObject(s) &&
        ['sourceSystem', 'sourceFile', 'sourceRecordId'].every(
          (k) => typeof s[k] === 'string' && s[k] !== '',
        ),
    )
  )
}

function capped(label: string, paths: string[]): string[] {
  if (paths.length === 0) return []
  const shown = paths.slice(0, 3).join(', ')
  const more = paths.length > 3 ? ` (+${String(paths.length - 3)} more)` : ''
  return [`${label}: ${shown}${more}`]
}

/**
 * R19: every object inside a response array carries sources [{ sourceSystem, sourceFile,
 * sourceRecordId }], and every `sources` array anywhere is well formed. With `entity`, the
 * top-level object (a single provider or property) must carry sources too.
 */
export function checkSources(payload: Json, options: { entity?: boolean } = {}): CheckResult {
  const missing: string[] = []
  const malformed: string[] = []
  walk(payload, (value, path, key) => {
    if (key !== undefined && SOURCE_EXEMPT_KEYS.has(key)) {
      if (key === 'sources' && !hasValidSources({ sources: value })) malformed.push(path)
      return false
    }
    if (Array.isArray(value)) {
      value.forEach((el, i) => {
        if (isObject(el) && !hasValidSources(el)) missing.push(`${path}[${String(i)}]`)
      })
    }
    return true
  })
  if (options.entity === true && !(isObject(payload) && hasValidSources(payload))) {
    missing.unshift('$ (top-level entity)')
  }
  return {
    failures: [
      ...capped('R19 item without sources', missing),
      ...capped('R19 malformed sources', malformed),
    ],
    notes: [],
  }
}

function mask(value: string): string {
  return value.replace(/[A-Za-z0-9]/g, (c, i: number) => (i < 2 ? c : '*'))
}

/** R17: no phone- or email-shaped string anywhere in the response. */
export function checkNoPii(payload: Json): CheckResult {
  const hits: string[] = []
  collectStrings(payload).forEach(({ path, value }) => {
    PHONE_PATTERNS.forEach((pattern) => {
      ;[...value.matchAll(pattern)].forEach((m) => {
        hits.push(`${path} phone-like "${mask(m[0])}"`)
      })
    })
    ;[...value.matchAll(EMAIL_PATTERN)]
      .filter((m) => !ICS_UID_SUFFIX.test(m[0]) || !path.endsWith('sourceRecordId'))
      .forEach((m) => {
        hits.push(`${path} email-like "${mask(m[0])}"`)
      })
  })
  return { failures: capped('R17 PII pattern', hits), notes: [] }
}

/** R12(e): every date-time carries the America/Chicago offset in force at that instant. */
export function checkTimeOffsets(payload: Json): CheckResult {
  const bad: string[] = []
  collectStrings(payload).forEach(({ path, value }) => {
    ;[...value.matchAll(ISO_DATETIME)].forEach((m) => {
      const offset = m[1]
      if (offset !== '-05:00' && offset !== '-06:00') {
        bad.push(`${path} "${m[0]}" (offset ${offset ?? 'missing'})`)
        return
      }
      const parsed = DateTime.fromISO(m[0], { setZone: true })
      const expectedOffset = parsed.setZone(ZONE).toFormat('ZZ')
      if (!parsed.isValid || expectedOffset !== offset) {
        bad.push(`${path} "${m[0]}" (Chicago offset at that instant is ${expectedOffset})`)
      }
    })
  })
  return { failures: capped('R12 time without the Chicago offset', bad), notes: [] }
}

/**
 * R17(c): a house number appears only when the caller supplied it. Hundred-block numbers
 * (ending in 00, e.g. "4500 block of Live Oak St") are allowed.
 */
export function checkHouseNumbers(payload: Json, allowed: string[]): CheckResult {
  const bad: string[] = []
  walk(payload, (value, path, key) => {
    if (key === 'sourceRecordId' || key === 'sourceFile') return false
    if (
      key !== undefined &&
      HOUSE_NUMBER_KEYS.has(key.toLowerCase()) &&
      value !== null &&
      !allowed.includes(typeof value === 'string' ? value : JSON.stringify(value))
    ) {
      bad.push(`${path} = ${JSON.stringify(value)}`)
    }
    if (typeof value === 'string') {
      ;[...value.matchAll(ADDRESS_PATTERN)].forEach((m) => {
        const number = m[1] ?? ''
        if (!number.endsWith('00') && !allowed.includes(number)) bad.push(`${path} "${m[0]}"`)
      })
    }
    return true
  })
  return { failures: capped('R17 house number not supplied by the caller', bad), notes: [] }
}

/** Assertions every response must satisfy, whatever the question. */
export function checkCommon(
  payload: Json,
  options: { allowedHouseNumbers: string[]; entity?: boolean },
): CheckResult {
  return merge(
    checkSources(payload, options.entity === true ? { entity: true } : {}),
    checkNoPii(payload),
    checkTimeOffsets(payload),
    checkHouseNumbers(payload, options.allowedHouseNumbers),
  )
}

/** A default response small enough for a live agent's context; the size is always noted. */
export function checkResponseSize(bytes: number, maxBytes: number): CheckResult {
  const kb = (n: number) => `${(n / 1000).toFixed(1)} KB`
  if (bytes >= maxBytes) {
    return {
      failures: [`default response is ${kb(bytes)}, over the ${kb(maxBytes)} budget`],
      notes: [],
    }
  }
  return { failures: [], notes: [`default response ${kb(bytes)} (budget ${kb(maxBytes)})`] }
}
