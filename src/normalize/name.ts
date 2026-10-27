const LEGAL_WORDS = new Set(['llc', 'inc', 'co', 'company', 'the'])

/**
 * Lower case, apostrophes dropped, other punctuation → space, the words llc|inc|co|company|the
 * removed as whole words, whitespace collapsed. Names are aliases and weak evidence (D-016).
 */
export function normalizeBusinessName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((word) => word !== '' && !LEGAL_WORDS.has(word))
    .join(' ')
}

/** Lower-cased domain after "@", or null when there is none. */
export function emailDomain(raw: string | null): string | null {
  if (raw === null) return null
  const match = /^[^@\s]+@([^@\s]+\.[^@\s]+)$/.exec(raw.trim())
  return match?.[1]?.toLowerCase() ?? null
}

/** Lower-cased host without scheme, "www.", port, path or query, or null. */
export function websiteHost(raw: string | null): string | null {
  if (raw === null) return null
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split(/[/?#]/)[0]
    ?.replace(/:\d+$/, '')
    .replace(/^www\./, '')
  return host === undefined || host === '' ? null : host
}
