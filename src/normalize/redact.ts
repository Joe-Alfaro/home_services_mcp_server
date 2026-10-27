const MARKER = '[redacted]'

// A US phone in any common spelling, not glued to other digits (keeps "4512", "11/3", "$145").
const PHONE = /(?<![\d+])(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
 * case-insensitive) from free text before it leaves the server (R17 (d), G27).
 */
export function redactText(
  text: string | null,
  options: { names?: readonly string[] } = {},
): string | null {
  if (text === null) return null
  const withoutContacts = text.replace(EMAIL, MARKER).replace(PHONE, MARKER)
  return nameTerms(options.names ?? []).reduce((result, term) => {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, 'giu')
    return result.replace(pattern, MARKER)
  }, withoutContacts)
}
