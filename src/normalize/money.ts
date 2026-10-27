// Dollars with optional "$", thousands commas and up to two decimals: "$1,234.50", "385", "1234.5".
const DOLLARS = /^\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/

/** Converts a dollar amount to integer cents; null when blank or unparseable (never a float). */
export function dollarsToCents(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw * 100) : null
  const match = DOLLARS.exec(raw.trim())
  if (!match?.[1]) return null
  const whole = Number(match[1].replaceAll(',', ''))
  const fraction = Number((match[2] ?? '').padEnd(2, '0'))
  return whole * 100 + fraction
}
