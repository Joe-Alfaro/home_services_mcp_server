import { describe, expect, it } from 'vitest'
import { dollarsToCents } from '../../../src/normalize/money.ts'

// R4 (e): money is integer cents, never floats.
describe('dollarsToCents', () => {
  it.each([
    ['$1460', 146000],
    ['$1,234.50', 123450],
    ['1234.50', 123450],
    ['1234.5', 123450],
    ['385', 38500],
    ['$145', 14500],
    ['145.00', 14500],
    ['99.50', 9950],
    ['0.29', 29],
    ['19.99', 1999],
    ['0', 0],
    ['0.00', 0],
    [' $75 ', 7500],
  ])('converts %j to %i cents', (raw, cents) => {
    const result = dollarsToCents(raw)
    expect(result).toBe(cents)
    expect(Number.isInteger(result)).toBe(true)
  })

  it('accepts a numeric dollar amount', () => {
    expect(dollarsToCents(12.5)).toBe(1250)
  })

  it.each([null, '', '   '])('returns null for blank %j', (raw) => {
    expect(dollarsToCents(raw)).toBeNull()
  })

  it.each(['abc', '$', '12.345', '1.2.3'])('returns null for unparseable %j', (raw) => {
    expect(dollarsToCents(raw)).toBeNull()
  })
})
