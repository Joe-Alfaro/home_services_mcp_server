/*
 * R17 (d): the redactor must catch homeowner names however the free text spells them. Two
 * spellings slip through today: a curly apostrophe (’) where the name has a straight one (or the
 * reverse), and accent-folded variants (José/Jose, Zoë/Zoe) in either direction.
 *
 * Expected behaviour (src/normalize/redact.ts, redactText): name matching treats ' and ’ (and ‘)
 * as the same character and compares letters with diacritics removed (NFD, combining marks
 * dropped), still whole words and case-insensitive. Text that is not a name is kept as written.
 * The replacement marker stays free (as in redact.test.ts).
 */
import { describe, expect, it } from 'vitest'
import { redactText } from '../../../src/normalize/redact.ts'

function redact(text: string, names: readonly string[]): string {
  const result = redactText(text, { names })
  if (result === null) throw new Error('expected a string')
  return result
}

/** Every spelling of the name parts that must be gone. */
const LEFTOVER = /o['’‘]?rourke|jos[eé]|alv[aá]rez|zo[eë]|brontë|bronte/i

describe('R17(d): curly and straight apostrophes', () => {
  it.each([
    ["Pat O'Rourke", 'Spoke with Pat O’Rourke about the gate'],
    ['Pat O’Rourke', "Spoke with Pat O'Rourke about the gate"],
    ["Pat O'Rourke", 'Mrs. O‘Rourke wants a call back'],
    ["Pat O'Rourke", 'O’ROURKE said the side door sticks'],
  ])('R17(d): name %j is removed from %j', (name, text) => {
    const result = redact(text, [name])

    expect(result).not.toMatch(LEFTOVER)
    expect(result).not.toBe(text)
  })

  it('R17(d): a curly apostrophe that is not part of a name is kept', () => {
    expect(redact('Customer’s gate sticks', ["Pat O'Rourke"])).toBe('Customer’s gate sticks')
  })
})

describe('R17(d): accent-folded names', () => {
  it.each([
    ['José Alvarez', 'Jose Alvarez called about the leak'],
    ['Jose Alvarez', 'José Álvarez called about the leak'],
    ['José Alvarez', 'JOSÉ will be home after 3'],
    ['Zoë Brontë', 'Left a note for Zoe Bronte at the back door'],
    ['Zoe Bronte', 'Left a note for Zoë Brontë at the back door'],
  ])('R17(d): name %j is removed from %j', (name, text) => {
    const result = redact(text, [name])

    expect(result).not.toMatch(LEFTOVER)
    expect(result).not.toBe(text)
  })

  it('R17(d): text around a folded name is kept as written', () => {
    const result = redact('Café visit: Jose said fix the façade light', ['José Alvarez'])

    expect(result).not.toMatch(LEFTOVER)
    expect(result.startsWith('Café visit: ')).toBe(true)
    expect(result.endsWith(' said fix the façade light')).toBe(true)
  })

  it('R17(d): folding never matches part of a longer word', () => {
    expect(redact('Joseph replaced the hose', ['José Alvarez'])).toBe('Joseph replaced the hose')
  })
})
