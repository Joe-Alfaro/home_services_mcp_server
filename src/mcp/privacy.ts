import { redactText } from '../normalize/redact.ts'

/** R19 citation, as the read views build it. */
export interface Source {
  sourceSystem: string
  sourceFile: string
  sourceRecordId: string
}

export interface ProviderRef {
  providerId: string
  name: string
}

function isSource(value: unknown): value is Source {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).sourceSystem === 'string' &&
    typeof (value as Record<string, unknown>).sourceFile === 'string' &&
    typeof (value as Record<string, unknown>).sourceRecordId === 'string'
  )
}

/** A view's `sources` jsonb column (already parsed by pg). */
export function readSources(value: unknown): Source[] {
  return Array.isArray(value) ? value.filter(isSource) : []
}

/** Distinct citations in a stable order. */
export function mergeSources(...lists: readonly (readonly Source[])[]): Source[] {
  const byKey = new Map<string, Source>()
  lists.flat().forEach((source) => {
    const key = `${source.sourceSystem}\u0000${source.sourceFile}\u0000${source.sourceRecordId}`
    if (!byKey.has(key)) byKey.set(key, source)
  })
  return [...byKey.values()].sort(
    (a, b) =>
      a.sourceSystem.localeCompare(b.sourceSystem) ||
      a.sourceFile.localeCompare(b.sourceFile) ||
      a.sourceRecordId.localeCompare(b.sourceRecordId, undefined, { numeric: true }),
  )
}

const STREET_SUFFIXES =
  'St|Street|Ave|Avenue|Dr|Drive|Rd|Road|Blvd|Boulevard|Ln|Lane|Pkwy|Parkway|Ct|Court|Pl|Place|Cir|Circle|Trl|Trail|Way|Ter|Terrace|Hwy|Highway'
// A house number followed by up to four street words and a street type: "4518 Live Oak St".
const STREET_ADDRESS = new RegExp(
  `(?<![\\w-])(\\d{1,6})(\\s+(?:[A-Za-z][A-Za-z.']*\\s+){1,4}(?:${STREET_SUFFIXES})\\b)`,
  'gi',
)
// Long digit runs (account numbers, unformatted phones) never help an agent.
const LONG_DIGITS = /(?<!\d)\d{7,}(?!\d)/g

/**
 * Free text on its way out (R17 d): phones and emails removed, and any street address reduced to
 * its hundred block unless the caller supplied that house number. Homeowner names were already
 * redacted per property by the pipeline (D-096).
 */
export function safeText(
  text: string | null,
  allowedHouseNumbers: readonly string[] = [],
): string | null {
  const redacted = redactText(text)
  if (redacted === null) return null
  const trimmed = redacted
    .replace(STREET_ADDRESS, (match, number: string, rest: string) => {
      if (allowedHouseNumbers.includes(number)) return match
      return `${String(Math.floor(Number(number) / 100) * 100)} block of${rest}`
    })
    .replace(LONG_DIGITS, '[redacted]')
    .trim()
  return trimmed === '' ? null : trimmed
}
