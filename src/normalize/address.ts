import { segmentHolds, type StreetIndex } from './geocode.ts'

/** Raw address as an adapter emits it (structurally the adapter contract's RawAddress). */
export interface RawAddress {
  line1: string | null
  line2: string | null
  city: string | null
  state: string | null
  zip: string | null
  /** Set when the source has only one free-text address field; line1..zip are then null. */
  freeText: string | null
}

export interface ParsedAddress {
  houseNumber: string | null
  streetName: string | null
  streetType: string | null
  unit: string | null
  city: string | null
  state: string | null
  zip: string | null
}

export type StreetMatch =
  | {
      status: 'exact' | 'fuzzy'
      streetName: string
      streetType: string
      confidence: number
      /** Edits from the given street to the matched one (0 when exact). */
      editDistance: number
    }
  | { status: 'none' | 'ambiguous'; streetName: null; streetType: null; confidence: 0 }

export interface NormalizedAddress extends ParsedAddress {
  key: string
  zipInferred: boolean
  streetMatch: StreetMatch['status']
  /** Edits between the given and the matched reference street; null when nothing matched. */
  streetEditDistance: number | null
  /** 1 = structured, exact street, own zip; lower when anything was guessed. */
  confidence: number
  blockNumber: number | null
  blockLabel: string | null
  reasons: string[]
}

/** Confidence of a free-text address and of an inferred zip (ARCHITECTURE "Resolution methods"). */
export const FREE_TEXT_CONFIDENCE = 0.8
export const INFERRED_ZIP_CONFIDENCE = 0.85
/** A street matched to the reference by edit distance (D-043, R8 c). */
export const FUZZY_STREET_CONFIDENCE: Readonly<{ oneEdit: number; twoEdits: number }> = {
  oneEdit: 0.9,
  twoEdits: 0.8,
}

const STREET_TYPES: Readonly<Record<string, string>> = {
  st: 'St',
  str: 'St',
  street: 'St',
  ave: 'Ave',
  av: 'Ave',
  avenue: 'Ave',
  rd: 'Rd',
  road: 'Rd',
  dr: 'Dr',
  drive: 'Dr',
  ln: 'Ln',
  lane: 'Ln',
  blvd: 'Blvd',
  boulevard: 'Blvd',
  ct: 'Ct',
  court: 'Ct',
  pl: 'Pl',
  place: 'Pl',
  cir: 'Cir',
  circle: 'Cir',
  pkwy: 'Pkwy',
  parkway: 'Pkwy',
  hwy: 'Hwy',
  highway: 'Hwy',
  trl: 'Trl',
  trail: 'Trl',
  ter: 'Ter',
  terrace: 'Ter',
  way: 'Way',
  sq: 'Sq',
  square: 'Sq',
  fwy: 'Fwy',
  freeway: 'Fwy',
  expy: 'Expy',
  expressway: 'Expy',
}

const DIRECTIONS: Readonly<Record<string, string>> = {
  n: 'N',
  north: 'N',
  s: 'S',
  south: 'S',
  e: 'E',
  east: 'E',
  w: 'W',
  west: 'W',
  ne: 'NE',
  northeast: 'NE',
  nw: 'NW',
  northwest: 'NW',
  se: 'SE',
  southeast: 'SE',
  sw: 'SW',
  southwest: 'SW',
}

const STATE_CODES = new Set(
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(
    ' ',
  ),
)
const STATE_NAMES: Readonly<Record<string, string>> = {
  texas: 'TX',
  oklahoma: 'OK',
  louisiana: 'LA',
  arkansas: 'AR',
  'new mexico': 'NM',
}

const UNIT_PREFIX = /^(?:apt|apartment|unit|ste|suite|no|#)\.?(?:\s*#)?\s*/i
const UNIT_MARKERS = new Set(['apt', 'apartment', 'unit', 'ste', 'suite', '#'])
const UNIT_VALUE = /^(?:[a-z]|\d+[a-z]?|[a-z]\d+)$/i

function clean(raw: string | null): string | null {
  if (raw === null) return null
  const text = raw.trim().replace(/\s+/g, ' ')
  return text === '' ? null : text
}

function titleCase(text: string): string {
  return text
    .toLowerCase()
    .split(' ')
    .map((word) => (word === '' ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
}

function bareWord(token: string): string {
  return token.toLowerCase().replace(/\.$/, '')
}

export function normalizeStreetType(raw: string | null): string | null {
  const text = clean(raw)
  if (text === null) return null
  return STREET_TYPES[bareWord(text)] ?? null
}

/** "Apt. b", "#B", "Unit B", "B" → "B". */
export function normalizeUnit(raw: string | null): string | null {
  const text = clean(raw)
  if (text === null) return null
  const value = text.replace(UNIT_PREFIX, '').replace(/\s+/g, '').toUpperCase()
  return value === '' ? null : value
}

/** Five-digit zip; ZIP+4 is cut to five digits. */
export function normalizeZip(raw: string | null): string | null {
  const text = clean(raw)
  if (text === null) return null
  return /^(\d{5})(?:-?\d{4})?$/.exec(text)?.[1] ?? null
}

export function normalizeState(raw: string | null): string | null {
  const text = clean(raw)
  if (text === null) return null
  const upper = text.toUpperCase().replace(/\.$/, '')
  if (STATE_CODES.has(upper)) return upper
  return STATE_NAMES[text.toLowerCase()] ?? null
}

interface StreetParts {
  houseNumber: string | null
  streetName: string | null
  streetType: string | null
  unit: string | null
  /** Tokens after the street and unit: city and state words. */
  rest: string[]
}

function isUnitMarker(token: string): boolean {
  return UNIT_MARKERS.has(bareWord(token)) || /^#\w+$/.test(token)
}

/** Reads the unit starting at tokens[i]; returns the unit and how many tokens it used. */
function readUnit(tokens: readonly string[], i: number): { unit: string; used: number } | null {
  const token = tokens[i]
  if (token === undefined) return null
  if (/^#\w+$/.test(token)) return { unit: token.slice(1).toUpperCase(), used: 1 }
  if (UNIT_MARKERS.has(bareWord(token))) {
    const next = tokens[i + 1] === '#' ? tokens[i + 2] : tokens[i + 1]
    if (next === undefined || next === ',') return null
    return { unit: normalizeUnit(next) ?? next.toUpperCase(), used: tokens[i + 1] === '#' ? 3 : 2 }
  }
  return null
}

/**
 * Splits "4512 Live Oak St Apt 4, Dallas TX" into parts. Commas are kept as tokens because a
 * comma ends the street: "1234 Sample Ave, B dallas" has unit B and city Dallas.
 */
function parseStreetLine(line: string): StreetParts {
  const tokens = line
    .replace(/,/g, ' , ')
    .split(/\s+/)
    .filter((token) => token !== '')
  const numberMatch = /^(\d+)[a-z]?$/i.exec(tokens[0] ?? '')
  const houseNumber = numberMatch?.[1] ?? null
  const start = houseNumber === null ? 0 : 1

  // The street runs to the first comma or unit marker.
  const endIndex = tokens.findIndex(
    (token, i) => i >= start && (token === ',' || isUnitMarker(token)),
  )
  const streetEnd = endIndex === -1 ? tokens.length : endIndex
  const streetTokens = tokens.slice(start, streetEnd)

  // The street type is the first type word with a name before it ("100 Court St" → Court, St).
  const typeAt = streetTokens.findIndex((token, i) => i > 0 && normalizeStreetType(token) !== null)
  const nameTokens = typeAt === -1 ? streetTokens : streetTokens.slice(0, typeAt)
  const afterType = typeAt === -1 ? [] : streetTokens.slice(typeAt + 1)
  const streetType = typeAt === -1 ? null : normalizeStreetType(streetTokens[typeAt] ?? null)

  const [first, ...others] = nameTokens
  const direction = first === undefined ? undefined : DIRECTIONS[bareWord(first)]
  // "North Elm", "N. Elm" and "N Elm" → "N Elm"; a street named just "North" stays "North".
  const nameWords =
    direction !== undefined && others.length > 0
      ? [direction, titleCase(others.join(' '))]
      : [titleCase(nameTokens.join(' '))]
  const streetName = nameTokens.length === 0 ? null : nameWords.join(' ')

  // After the street: an optional unit (marker form, or a bare "B"/"4" token), then city/state.
  const tail = [...afterType, ...tokens.slice(streetEnd)].filter((token) => token !== ',')
  const marked = readUnit(tail, 0)
  if (marked !== null) {
    return { houseNumber, streetName, streetType, unit: marked.unit, rest: tail.slice(marked.used) }
  }
  const [head, ...rest] = tail
  if (head !== undefined && UNIT_VALUE.test(head) && !STATE_CODES.has(head.toUpperCase())) {
    return { houseNumber, streetName, streetType, unit: head.toUpperCase(), rest }
  }
  return { houseNumber, streetName, streetType, unit: null, rest: tail }
}

/** City and state words from the tail of a free-text address: "Dallas TX", "dallas". */
function cityAndState(tokens: readonly string[]): { city: string | null; state: string | null } {
  const words = tokens.filter((token) => token !== ',')
  const last = words.at(-1)
  const state = last === undefined ? null : normalizeState(last)
  const cityWords = state === null ? words : words.slice(0, -1)
  return { city: cityWords.length === 0 ? null : titleCase(cityWords.join(' ')), state }
}

/** Syntax only, no reference lookup. Reads line1..zip, or freeText when the source has one field. */
export function parseAddress(raw: RawAddress): ParsedAddress {
  const freeText = raw.line1 === null ? clean(raw.freeText) : null
  if (freeText !== null) {
    // The zip is the last 5-digit (or ZIP+4) token that isn't the house number.
    const zipPattern = /(?<!^)\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/
    const zip = zipPattern.exec(freeText)?.[1] ?? null
    const text = zip === null ? freeText : freeText.replace(zipPattern, ' ')
    const parts = parseStreetLine(text)
    const { city, state } = cityAndState(parts.rest)
    return {
      houseNumber: parts.houseNumber,
      streetName: parts.streetName,
      streetType: parts.streetType,
      unit: parts.unit,
      city,
      state,
      zip,
    }
  }
  const parts = parseStreetLine(clean(raw.line1) ?? '')
  const city = clean(raw.city)
  return {
    houseNumber: parts.houseNumber,
    streetName: parts.streetName,
    streetType: parts.streetType,
    unit: normalizeUnit(raw.line2) ?? parts.unit,
    city: city === null ? null : titleCase(city),
    state: normalizeState(raw.state),
    zip: normalizeZip(raw.zip),
  }
}

/** Home identity: number + street + type + unit + zip. Equal homes give equal keys. */
export function addressKey(address: ParsedAddress): string {
  return [
    address.houseNumber,
    address.streetName?.toLowerCase(),
    address.streetType?.toLowerCase(),
    address.unit?.toLowerCase(),
    address.zip,
  ]
    .map((part) => part ?? '')
    .join('|')
}

/** Optimal string alignment distance: edits plus adjacent transpositions ("Lvie" ↔ "Live"). */
function editDistance(a: string, b: string): number {
  // rows[i][j] starts as i + j, which is exact on the first row and column.
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => i + j),
  )
  const at = (i: number, j: number) => rows[i]?.[j] ?? Number.POSITIVE_INFINITY
  Array.from(a).forEach((charA, ai) => {
    Array.from(b).forEach((charB, bi) => {
      const i = ai + 1
      const j = bi + 1
      const cost = charA === charB ? 0 : 1
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost)
      if (i > 1 && j > 1 && charA === b[bi - 1] && a[ai - 1] === charB) {
        best = Math.min(best, at(i - 2, j - 2) + 1)
      }
      const row = rows[i]
      if (row !== undefined) row[j] = best
    })
  })
  return at(a.length, b.length)
}

const NO_MATCH = { streetName: null, streetType: null, confidence: 0 } as const

/** Names shorter than this never match fuzzily: one edit to "Elm" is a different street. */
const MIN_FUZZY_LENGTH = 5

/**
 * Matches a street name against the reference, restricted to `zip` when given (D-043). A typo
 * matches as fuzzy only when one reference street is strictly closest; a tie stays ambiguous.
 */
export function matchStreet(
  streetName: string,
  streetType: string | null,
  zip: string | null,
  index: StreetIndex,
): StreetMatch {
  const name = streetName.trim().toLowerCase().replace(/\s+/g, ' ')
  const type = streetType?.toLowerCase() ?? null
  const streets = new Map<string, { streetName: string; streetType: string }>()
  index.segments
    .filter((segment) => zip === null || segment.zip === zip)
    .forEach((segment) => {
      const key = `${segment.streetName.toLowerCase()}|${segment.streetType.toLowerCase()}`
      streets.set(key, { streetName: segment.streetName, streetType: segment.streetType })
    })
  const candidates = [...streets.values()]

  const exact = candidates.filter(
    (street) =>
      street.streetName.toLowerCase() === name &&
      (type === null || street.streetType.toLowerCase() === type),
  )
  const [onlyExact] = exact
  if (exact.length > 1) return { status: 'ambiguous', ...NO_MATCH }
  if (onlyExact !== undefined) {
    return { status: 'exact', ...onlyExact, confidence: 1, editDistance: 0 }
  }
  if (name.length < MIN_FUZZY_LENGTH) return { status: 'none', ...NO_MATCH }

  // A wrong street type counts as one more edit.
  const maxDistance = name.length >= 10 ? 2 : 1
  const scored = candidates
    .map((street) => ({
      street,
      distance:
        editDistance(name, street.streetName.toLowerCase()) +
        (type !== null && street.streetType.toLowerCase() !== type ? 1 : 0),
    }))
    .filter((entry) => entry.distance <= maxDistance)
  if (scored.length === 0) return { status: 'none', ...NO_MATCH }
  const best = Math.min(...scored.map((entry) => entry.distance))
  const closest = scored.filter((entry) => entry.distance === best)
  const [winner] = closest
  if (closest.length > 1 || winner === undefined) return { status: 'ambiguous', ...NO_MATCH }
  return {
    status: 'fuzzy',
    ...winner.street,
    confidence: best === 1 ? FUZZY_STREET_CONFIDENCE.oneEdit : FUZZY_STREET_CONFIDENCE.twoEdits,
    editDistance: best,
  }
}

/**
 * Parses the address, corrects the street against the reference, infers a missing zip when
 * exactly one target-zip segment holds that number and street, and labels the hundred block.
 */
export function normalizeAddress(raw: RawAddress, index: StreetIndex): NormalizedAddress {
  const parsed = parseAddress(raw)
  const reasons: string[] = []
  const confidences: number[] = [1]
  const isFreeText = raw.line1 === null && clean(raw.freeText) !== null
  if (isFreeText) {
    reasons.push('free_text')
    confidences.push(FREE_TEXT_CONFIDENCE)
  }

  let { streetName, streetType, zip } = parsed
  let zipInferred = false
  let streetMatch: StreetMatch['status'] = 'none'
  let streetEditDistance: number | null = null
  const zipInReference = zip === null || index.targetZips.has(zip)
  if (streetName !== null && zipInReference) {
    const match = matchStreet(streetName, streetType, zip, index)
    streetMatch = match.status
    if (match.status === 'exact' || match.status === 'fuzzy') {
      streetEditDistance = match.editDistance
      streetName = match.streetName
      streetType = match.streetType
      if (match.status === 'fuzzy') {
        reasons.push('fuzzy_street')
        confidences.push(match.confidence)
      }
    } else if (match.status === 'ambiguous') {
      reasons.push('ambiguous_street')
    } else {
      reasons.push('unknown_street')
    }
  }

  const houseNumber = parsed.houseNumber === null ? null : Number.parseInt(parsed.houseNumber, 10)
  if (zip === null && houseNumber !== null && streetName !== null && streetMatch !== 'none') {
    const matchedName = streetName
    const zips = new Set(
      index.segments
        .filter((segment) => segmentHolds(segment, matchedName, streetType, houseNumber))
        .map((segment) => segment.zip),
    )
    const [onlyZip] = zips
    if (zips.size === 1 && onlyZip !== undefined && streetMatch !== 'ambiguous') {
      zip = onlyZip
      zipInferred = true
      reasons.push('zip_inferred')
      confidences.push(INFERRED_ZIP_CONFIDENCE)
    } else if (zips.size > 1 && streetMatch !== 'ambiguous') {
      streetMatch = 'ambiguous'
      reasons.push('ambiguous_street')
    }
  }

  const blockNumber = houseNumber === null ? null : Math.floor(houseNumber / 100) * 100
  const blockStreet = [streetName, streetType].filter((part) => part !== null).join(' ')
  const normalized: ParsedAddress = { ...parsed, streetName, streetType, zip }
  return {
    ...normalized,
    key: addressKey(normalized),
    zipInferred,
    streetMatch,
    streetEditDistance,
    confidence: Math.min(...confidences),
    blockNumber,
    blockLabel:
      blockNumber === null || blockStreet === ''
        ? null
        : `${String(blockNumber)} block of ${blockStreet}`,
    reasons,
  }
}
