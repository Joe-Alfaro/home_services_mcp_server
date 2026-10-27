import { describe, expect, it } from 'vitest'
import { emailDomain, normalizeBusinessName, websiteHost } from '../../../src/normalize/name.ts'

/*
 * API pinned for src/normalize/name.ts (ARCHITECTURE "Resolution methods"):
 *
 * // Lower case, punctuation removed (apostrophes dropped, other punctuation → space), the words
 * // llc|inc|co|company|the removed as whole words, whitespace collapsed and trimmed.
 * export function normalizeBusinessName(raw: string): string
 * // Lower-cased domain after "@", or null when there is none.
 * export function emailDomain(raw: string | null): string | null
 * // Lower-cased host without scheme, "www.", port, path or query, or null.
 * export function websiteHost(raw: string | null): string | null
 */

describe('normalizeBusinessName (G13, G20)', () => {
  it.each([
    'Acme Plumbing',
    'Acme Plumbing Co LLC',
    'Acme Plumbing Co.',
    'ACME PLUMBING, LLC',
    'The Acme Plumbing Company',
    'Acme Plumbing Inc.',
    '  acme   plumbing  ',
  ])('%j → "acme plumbing"', (raw) => {
    expect(normalizeBusinessName(raw)).toBe('acme plumbing')
  })

  it('"Dot\'s Fix-It" and "Dots Fix It" normalize alike', () => {
    expect(normalizeBusinessName("Dot's Fix-It")).toBe(normalizeBusinessName('Dots Fix It'))
  })

  it('strips the legal words only as whole words', () => {
    expect(normalizeBusinessName('Coastal Cooling Co')).toBe('coastal cooling')
    expect(normalizeBusinessName('Theory Electric Inc')).toBe('theory electric')
    expect(normalizeBusinessName('Incline Painting')).toBe('incline painting')
  })

  it('keeps distinguishing words, so a shared prefix stays a different name', () => {
    expect(normalizeBusinessName('Acme Termite & Pest')).not.toBe(
      normalizeBusinessName('Acme Plumbing'),
    )
  })
})

describe('emailDomain', () => {
  it.each([
    ['office@AcmePlumbing.example', 'acmeplumbing.example'],
    ['  jo.sample@acmeplumbing.example ', 'acmeplumbing.example'],
  ])('%j → %j', (raw, expected) => {
    expect(emailDomain(raw)).toBe(expected)
  })

  it.each([null, '', 'not an email'])('%j → null', (raw) => {
    expect(emailDomain(raw)).toBeNull()
  })
})

describe('websiteHost', () => {
  it.each([
    'https://www.acmeplumbing.example/',
    'http://acmeplumbing.example/about?ref=1',
    'www.AcmePlumbing.example',
    'acmeplumbing.example',
    'https://acmeplumbing.example:443/contact',
  ])('%j → acmeplumbing.example', (raw) => {
    expect(websiteHost(raw)).toBe('acmeplumbing.example')
  })

  it.each([null, ''])('%j → null', (raw) => {
    expect(websiteHost(raw)).toBeNull()
  })
})
