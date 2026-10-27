import { describe, expect, it } from 'vitest'
import { redactText } from '../../../src/normalize/redact.ts'

/*
 * API pinned for src/normalize/redact.ts (R17 (d), G27):
 *
 * // Removes phone numbers, email addresses and the given homeowner names (each full name and each
 * // of its words of 2+ letters, case-insensitive, whole words only). The replacement marker is
 * // free; everything else in the text is kept. Returns null for null.
 * export function redactText(text: string | null, options?: { names?: readonly string[] }): string | null
 */

const NAMES = ['Alex Sample', "Pat O'Rourke"]

function redact(text: string): string {
  const result = redactText(text, { names: NAMES })
  if (result === null) throw new Error('expected a string')
  return result
}

describe('redactText: phones (R17 (d))', () => {
  it.each([
    'call 214-555-0100 before',
    'call (214) 555-0100 before',
    'call 214.555.0100 before',
    'call +1 214 555 0100 before',
    'call +1 (214) 555-0100 before',
    'call 2145550100 before',
  ])('removes the phone in %j', (text) => {
    const result = redact(text)
    expect(result.replace(/\D/g, '')).not.toContain('5550100')
    expect(result).toContain('call')
    expect(result).toContain('before')
  })
})

describe('redactText: emails (R17 (d))', () => {
  it('removes email addresses', () => {
    const result = redact('send invoice to alex.sample+home@example.com and jo@mail.example.org')
    expect(result).not.toMatch(/@/)
    expect(result).not.toContain('example.com')
    expect(result).toContain('send invoice to')
  })
})

describe('redactText: known homeowner names (R17 (d), G27)', () => {
  it('removes a full name', () => {
    const result = redact('Alex Sample: tv mount')
    expect(result).not.toMatch(/alex|sample/i)
    expect(result).toContain('tv mount')
  })

  it('removes a surname used alone, whatever its case', () => {
    expect(redact('Mrs. sample wants Tues')).not.toMatch(/sample/i)
    expect(redact('SAMPLE gate code')).not.toMatch(/sample/i)
  })

  it('removes a first name used alone', () => {
    expect(redact('ask for Alex at the side door')).not.toMatch(/alex/i)
  })

  it('handles names with punctuation', () => {
    expect(redact("Pat O'Rourke said leak is back")).not.toMatch(/o'rourke|pat\b/i)
  })

  it('removes names only as whole words', () => {
    const result = redactText('Annual leak check, Leesburg valve', { names: ['Ann Lee'] })
    expect(result).toContain('Annual')
    expect(result).toContain('Leesburg')
  })
})

describe('redactText: keeps the job facts', () => {
  it('keeps amounts, dates, times, sizes and house numbers', () => {
    const result = redact(
      'Replace water heater - gas 40G, $145 deposit, 11/3 at 9:30, 4512 Live Oak',
    )
    expect(result).toContain('Replace water heater - gas 40G')
    expect(result).toContain('$145')
    expect(result).toContain('11/3')
    expect(result).toContain('9:30')
    expect(result).toContain('4512 Live Oak')
  })

  it('returns text without PII unchanged', () => {
    expect(redact('fence boards')).toBe('fence boards')
    expect(redactText('fence boards')).toBe('fence boards')
  })

  it('returns null for null', () => {
    expect(redactText(null, { names: NAMES })).toBeNull()
  })
})
