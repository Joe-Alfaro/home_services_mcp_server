import { describe, expect, it } from 'vitest'
import { normalizePhone } from '../../../src/normalize/phone.ts'

/*
 * API pinned for src/normalize/phone.ts:
 *
 * // US numbers → 10 digits; a leading country code 1 is dropped. Anything else → null.
 * export function normalizePhone(raw: string | null): string | null
 */

describe('normalizePhone (G20, R6)', () => {
  it.each([
    '214-555-0100',
    '214.555.0100',
    '2145550100',
    '(214) 555-0100',
    '+1 214 555 0100',
    '+1 (214) 555-0100',
    '1-214-555-0100',
    '12145550100',
    ' 214 555 0100 ',
  ])('%j → 2145550100', (raw) => {
    expect(normalizePhone(raw)).toBe('2145550100')
  })

  it.each([null, '', 'n/a', '555-0100', '214-555-010', '22145550100', '+44 20 7946 0958'])(
    '%j → null',
    (raw) => {
      expect(normalizePhone(raw)).toBeNull()
    },
  )
})
