const MARKER = '[redacted]'

// A US phone in any common spelling, not glued to other digits (keeps "4512", "11/3", "$145").
const PHONE = /(?<![\d+])(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const APOSTROPHES = /['\u2018\u2019]/g
const COMBINING_MARKS = /\p{M}/gu

/** Diacritics dropped (NFD, combining marks removed) and every apostrophe made straight. */
function fold(text: string): string {
  return text.normalize('NFD').replace(COMBINING_MARKS, '').replace(APOSTROPHES, "'")
}

/**
 * The folded text plus, for each folded position, the offset in `text` of the character it came
 * from (one extra entry for the end), so matches on the folded text map back to the original.
 */
function foldWithOffsets(text: string): { folded: string; offsets: number[] } {
  const chars = Array.from(text)
  const pieces = chars.map((char) => fold(char))
  const starts = chars.reduce<number[]>(
    (acc, char) => [...acc, (acc.at(-1) ?? 0) + char.length],
    [0],
  )
  const offsets = pieces.flatMap((piece, i) => Array<number>(piece.length).fill(starts[i] ?? 0))
  return { folded: pieces.join(''), offsets: [...offsets, text.length] }
}

/** Replaces whole-word, case-insensitive matches of `term`, compared folded, in `text`. */
function replaceName(text: string, term: string): string {
  const { folded, offsets } = foldWithOffsets(text)
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(fold(term))}(?![\\p{L}\\p{N}])`,
    'giu',
  )
  const ranges = [...folded.matchAll(pattern)].map((match) => ({
    start: offsets[match.index] ?? text.length,
    end: offsets[match.index + match[0].length] ?? text.length,
  }))
  return ranges.reduceRight(
    (result, range) => result.slice(0, range.start) + MARKER + result.slice(range.end),
    text,
  )
}

/** Each full name and each of its words of 2+ letters, longest first so full names go first. */
function nameTerms(names: readonly string[]): string[] {
  const terms = names.flatMap((name) => {
    const full = name.trim().replace(/\s+/g, ' ')
    const words = full.split(' ').filter((word) => word.replace(/[^\p{L}]/gu, '').length >= 2)
    return full === '' ? [] : [full, ...words]
  })
  return [...new Set(terms)].sort((a, b) => b.length - a.length)
}

/**
 * Removes phone numbers, email addresses and the given homeowner names (whole words,
 * case-insensitive) from free text before it leaves the server (R17 (d), G27). Names compare
 * with diacritics folded and curly apostrophes as straight ones; other text is kept as written.
 */
export function redactText(
  text: string | null,
  options: { names?: readonly string[] } = {},
): string | null {
  if (text === null) return null
  const withoutContacts = text.replace(EMAIL, MARKER).replace(PHONE, MARKER)
  return nameTerms(options.names ?? []).reduce(replaceName, withoutContacts)
}
