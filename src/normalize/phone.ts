/** US numbers → 10 digits; a leading country code 1 is dropped. Anything else → null. */
export function normalizePhone(raw: string | null): string | null {
  if (raw === null) return null
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return digits
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1)
  return null
}
