import { describe, expect, it } from 'vitest'
import {
  addressKey,
  matchStreet,
  normalizeAddress,
  normalizeState,
  normalizeStreetType,
  normalizeUnit,
  normalizeZip,
  parseAddress,
} from '../../../src/normalize/address.ts'
import { freeText, referenceIndex, structured } from './reference.ts'

/*
 * API pinned for src/normalize/address.ts (RawAddress is from src/adapters/types.ts,
 * StreetIndex from src/normalize/geocode.ts):
 *
 * export interface ParsedAddress {
 *   houseNumber: string | null // "4512"
 *   streetName: string | null  // Title Case, no type, single spaces: "Live Oak"
 *   streetType: string | null  // USPS abbreviation: "St", "Ave", "Rd", "Dr", "Ln", "Blvd", "Ct"
 *   unit: string | null        // prefix stripped, upper case: "4", "A", "102"
 *   city: string | null        // Title Case: "Dallas"
 *   state: string | null       // two letters: "TX"
 *   zip: string | null         // five digits
 * }
 * // Syntax only, no reference lookup. Reads line1..zip, or freeText when the source has one field.
 * export function parseAddress(raw: RawAddress): ParsedAddress
 * export function normalizeStreetType(raw: string | null): string | null
 * export function normalizeUnit(raw: string | null): string | null
 * export function normalizeZip(raw: string | null): string | null
 * export function normalizeState(raw: string | null): string | null
 * // Home identity: number + street + type + unit + zip. Format is free; equal homes give equal keys.
 * export function addressKey(address: ParsedAddress): string
 *
 * export type StreetMatch =
 *   | { status: 'exact' | 'fuzzy'; streetName: string; streetType: string; confidence: number }
 *   | { status: 'none' | 'ambiguous'; streetName: null; streetType: null; confidence: 0 }
 * // Matches a street name against the reference (restricted to `zip` when given).
 * export function matchStreet(
 *   streetName: string, streetType: string | null, zip: string | null, index: StreetIndex,
 * ): StreetMatch
 *
 * export interface NormalizedAddress extends ParsedAddress {
 *   key: string                 // addressKey() after street correction and zip inference
 *   zipInferred: boolean
 *   streetMatch: StreetMatch['status']
 *   confidence: number          // 1 = structured, exact street, own zip; < 1 when anything was guessed
 *   blockNumber: number | null  // 4500 for 4512
 *   blockLabel: string | null   // "4500 block of Live Oak St"
 *   reasons: string[]           // e.g. "zip_inferred", "fuzzy_street", "ambiguous_street"
 * }
 * export function normalizeAddress(raw: RawAddress, index: StreetIndex): NormalizedAddress
 */

const index = referenceIndex()

function keyOf(raw: Parameters<typeof normalizeAddress>[0]): string {
  return normalizeAddress(raw, index).key
}

describe('normalizeStreetType (G19)', () => {
  it.each([
    ['St', 'St'],
    ['St.', 'St'],
    ['ST', 'St'],
    ['Street', 'St'],
    ['street', 'St'],
    ['Ave', 'Ave'],
    ['Ave.', 'Ave'],
    ['AVE', 'Ave'],
    ['Avenue', 'Ave'],
    ['Rd', 'Rd'],
    ['Road', 'Rd'],
    ['Dr', 'Dr'],
    ['Drive', 'Dr'],
    ['Ln', 'Ln'],
    ['Lane', 'Ln'],
    ['Blvd', 'Blvd'],
    ['Boulevard', 'Blvd'],
    ['Ct', 'Ct'],
    ['Court', 'Ct'],
  ])('%j → %j', (raw, expected) => {
    expect(normalizeStreetType(raw)).toBe(expected)
  })

  it('returns null for blank input', () => {
    expect(normalizeStreetType(null)).toBeNull()
    expect(normalizeStreetType('')).toBeNull()
  })
})

describe('normalizeUnit (G19, G24)', () => {
  it.each([
    ['Apt 4', '4'],
    ['Apt. 4', '4'],
    ['apt 4', '4'],
    ['#4', '4'],
    ['# 4', '4'],
    ['Unit 4', '4'],
    ['Ste 4', '4'],
    ['4', '4'],
    ['Apt B', 'B'],
    ['Apt. b', 'B'],
    ['#B', 'B'],
    ['Unit B', 'B'],
    ['B', 'B'],
    ['Apt 102', '102'],
    ['#102', '102'],
  ])('%j → %j', (raw, expected) => {
    expect(normalizeUnit(raw)).toBe(expected)
  })

  it('returns null for a missing unit', () => {
    expect(normalizeUnit(null)).toBeNull()
    expect(normalizeUnit('')).toBeNull()
    expect(normalizeUnit('   ')).toBeNull()
  })
})

describe('normalizeZip (R7 ZIP+4, G19)', () => {
  it.each([
    ['75204', '75204'],
    ['75204-1234', '75204'],
    ['75214-1234', '75214'],
    [' 75204 ', '75204'],
  ])('%j → %j', (raw, expected) => {
    expect(normalizeZip(raw)).toBe(expected)
  })

  it.each([null, '', '7520', 'n/a'])('%j → null', (raw) => {
    expect(normalizeZip(raw)).toBeNull()
  })
})

describe('normalizeState (G19)', () => {
  it.each(['TX', 'tx', 'Texas', 'TEXAS', 'texas'])('%j → TX', (raw) => {
    expect(normalizeState(raw)).toBe('TX')
  })

  it('returns null for blank input', () => {
    expect(normalizeState('')).toBeNull()
    expect(normalizeState(null)).toBeNull()
  })
})

describe('parseAddress', () => {
  it('splits a structured CRM address with a separate unit field', () => {
    expect(
      parseAddress(
        structured('4512 LIVE OAK STREET', {
          line2: 'Apt. b',
          city: 'DALLAS',
          state: 'Texas',
          zip: '75204-3637',
        }),
      ),
    ).toEqual({
      houseNumber: '4512',
      streetName: 'Live Oak',
      streetType: 'St',
      unit: 'B',
      city: 'Dallas',
      state: 'TX',
      zip: '75204',
    })
  })

  it.each([
    [
      '123 Elm St Apt 4, Dallas TX 75204',
      { houseNumber: '123', streetName: 'Elm', streetType: 'St', unit: '4', zip: '75204' },
    ],
    [
      '123 elm street #4 dallas',
      { houseNumber: '123', streetName: 'Elm', streetType: 'St', unit: '4', city: 'Dallas' },
    ],
    [
      '123 ELM ST UNIT 4, 75204-1234',
      { houseNumber: '123', streetName: 'Elm', streetType: 'St', unit: '4', zip: '75204' },
    ],
    [
      '5823 Belmont Ave, Dallas, TX 75206',
      { houseNumber: '5823', streetName: 'Belmont', streetType: 'Ave', unit: null, zip: '75206' },
    ],
    ['1234 sample ave, B dallas', { streetName: 'Sample', unit: 'B', city: 'Dallas', zip: null }],
    ['1234 Sample Ave, A', { streetName: 'Sample', streetType: 'Ave', unit: 'A' }],
    ['1234 Sample Ave #B', { streetName: 'Sample', streetType: 'Ave', unit: 'B' }],
    ['1234 Sample Ave Apt. B', { streetName: 'Sample', streetType: 'Ave', unit: 'B' }],
    ['4512 Live Oak St, 75204', { streetName: 'Live Oak', streetType: 'St', zip: '75204' }],
  ])('parses CSV free text %j (G16, G19)', (text, expected) => {
    expect(parseAddress(freeText(text))).toMatchObject(expected)
  })

  it('leaves the street type null when the text has none', () => {
    expect(parseAddress(freeText('4512 Live Oak'))).toMatchObject({
      houseNumber: '4512',
      streetName: 'Live Oak',
      streetType: null,
    })
  })

  it('treats direction spellings alike but keeps different directions apart', () => {
    const north = addressKey(parseAddress(structured('100 North Elm St', { zip: '75204' })))
    expect(addressKey(parseAddress(structured('100 N. Elm St', { zip: '75204' })))).toBe(north)
    expect(addressKey(parseAddress(structured('100 N Elm Street', { zip: '75204' })))).toBe(north)
    expect(addressKey(parseAddress(structured('100 S Elm St', { zip: '75204' })))).not.toBe(north)
  })

  it('returns all-null parts for an empty address instead of throwing', () => {
    expect(parseAddress(freeText(''))).toMatchObject({ houseNumber: null, streetName: null })
  })
})

describe('R7 (a): address variants produce the same key', () => {
  it('"123 Elm St Apt 4, Dallas TX 75204", "123 elm street #4 dallas" and "123 ELM ST UNIT 4, 75204-1234"', () => {
    const a = keyOf(freeText('123 Elm St Apt 4, Dallas TX 75204'))
    expect(keyOf(freeText('123 elm street #4 dallas'))).toBe(a)
    expect(keyOf(freeText('123 ELM ST UNIT 4, 75204-1234'))).toBe(a)
    expect(
      keyOf(
        structured('123 Elm Street', {
          line2: 'Unit 4',
          city: 'Dallas',
          state: 'TX',
          zip: '75204',
        }),
      ),
    ).toBe(a)
  })

  it('G19: "1234 Sample Avenue", "1234 SAMPLE AVE." and "1234 sample ave" are one key', () => {
    const a = keyOf(freeText('1234 Sample Avenue'))
    expect(keyOf(freeText('1234 SAMPLE AVE.'))).toBe(a)
    expect(keyOf(freeText('1234 sample ave'))).toBe(a)
    expect(keyOf(structured('1234 Sample Ave', { zip: '75214-1234', state: 'Texas' }))).toBe(a)
  })

  it('G19: every unit spelling of 4 gives the same key', () => {
    const keys = ['Apt 4', 'Apt. 4', '#4', 'Unit 4', '4'].map((line2) =>
      keyOf(structured('1234 Sample Ave', { line2, zip: '75214' })),
    )
    expect(new Set(keys).size).toBe(1)
  })

  it('G24: "#A" and "Apt. A" are one home', () => {
    expect(keyOf(freeText('1234 Sample Ave #A'))).toBe(keyOf(freeText('1234 Sample Ave Apt. A')))
  })
})

describe('R7 (b): different units are different homes', () => {
  it('"123 Elm St Apt 4" and "123 Elm St Apt 5" do not share a key', () => {
    expect(keyOf(freeText('123 Elm St Apt 4'))).not.toBe(keyOf(freeText('123 Elm St Apt 5')))
  })

  it('G24: Apt A and Apt B at one number are different homes', () => {
    expect(keyOf(freeText('1234 Sample Ave Apt A'))).not.toBe(
      keyOf(freeText('1234 Sample Ave Apt B')),
    )
  })

  it('a unit and no unit are different homes', () => {
    expect(keyOf(freeText('123 Elm St Apt 4, 75204'))).not.toBe(
      keyOf(freeText('123 Elm St, 75204')),
    )
  })
})

describe('R7 (c): zip inference from street segments', () => {
  it('infers the zip when exactly one target-zip segment holds that number and street, and lowers confidence', () => {
    const inferred = normalizeAddress(structured('123 Elm St'), index)
    const given = normalizeAddress(structured('123 Elm St', { zip: '75204' }), index)
    expect(inferred.zip).toBe('75204')
    expect(inferred.zipInferred).toBe(true)
    expect(inferred.reasons).toContain('zip_inferred')
    expect(inferred.key).toBe(given.key)
    expect(given.zipInferred).toBe(false)
    expect(given.confidence).toBe(1)
    expect(inferred.confidence).toBeLessThan(given.confidence)
  })

  it('does not infer a zip when the number is outside every segment of that street', () => {
    const result = normalizeAddress(structured('950 Elm St'), index)
    expect(result.zip).toBeNull()
    expect(result.zipInferred).toBe(false)
  })

  it('G22: does not infer a zip for a street present in two zips (ambiguous_street)', () => {
    const result = normalizeAddress(structured('350 Glade Dr'), index)
    expect(result.zip).toBeNull()
    expect(result.zipInferred).toBe(false)
    expect(result.streetMatch).toBe('ambiguous')
    expect(result.reasons).toContain('ambiguous_street')
  })

  it('uses the given zip to pick one of two same-named streets', () => {
    const garland = normalizeAddress(structured('350 Glade Dr', { zip: '75041' }), index)
    const richardson = normalizeAddress(structured('350 Glade Dr', { zip: '75080' }), index)
    expect(garland.streetMatch).toBe('exact')
    expect(garland.key).not.toBe(richardson.key)
  })

  it('never overwrites a zip the source gave', () => {
    const result = normalizeAddress(structured('123 Elm St', { zip: '75206' }), index)
    expect(result.zip).toBe('75206')
    expect(result.zipInferred).toBe(false)
  })
})

describe('out-of-area addresses (R7 (e), G24)', () => {
  it('keeps an address outside the target zips with its own zip in the key', () => {
    const result = normalizeAddress(
      structured('100 Prairie Wind Dr', { city: 'Frisco', state: 'TX', zip: '75034' }),
      index,
    )
    expect(result.zip).toBe('75034')
    expect(result.streetMatch).toBe('none')
    expect(result.key).not.toBe('')
  })

  it('G24: the same number and street in two out-of-area zips are two homes', () => {
    expect(keyOf(structured('100 Prairie Wind Dr', { zip: '75034' }))).not.toBe(
      keyOf(structured('100 Prairie Wind Dr', { zip: '75019' })),
    )
  })
})

describe('street matching and typo tolerance (G19, G28)', () => {
  it('matches the reference street regardless of case', () => {
    expect(matchStreet('LIVE OAK', 'St', '75204', index)).toMatchObject({
      status: 'exact',
      streetName: 'Live Oak',
      streetType: 'St',
    })
  })

  it('matches a street given without a type when the name is unique', () => {
    expect(matchStreet('Live Oak', null, null, index)).toMatchObject({
      status: 'exact',
      streetName: 'Live Oak',
      streetType: 'St',
    })
  })

  it.each([
    ['Lvie Oak', 'St', '75204', 'Live Oak'],
    ['Liev Oak', 'St', '75204', 'Live Oak'],
    ['Belomnt', 'Ave', '75206', 'Belmont'],
  ])('matches the one-transposition typo %j to %j with confidence < 1', (typo, type, zip, name) => {
    const match = matchStreet(typo, type, zip, index)
    expect(match.status).toBe('fuzzy')
    expect(match.streetName).toBe(name)
    expect(match.confidence).toBeGreaterThan(0)
    expect(match.confidence).toBeLessThan(1)
  })

  it('G28: an unrelated street name does not match Belmont', () => {
    expect(matchStreet('Bellwood', 'Ave', '75206', index).status).toBe('none')
  })

  it('G19: a typo equally close to two reference streets stays unmatched', () => {
    const match = matchStreet('Pine Hll', 'Ln', '75214', index)
    expect(['none', 'ambiguous']).toContain(match.status)
    expect(match.streetName).toBeNull()
  })

  it('a typo address normalizes to the reference spelling and key, with lower confidence', () => {
    const typo = normalizeAddress(structured('4512 Lvie Oak St', { zip: '75204' }), index)
    const clean = normalizeAddress(structured('4512 Live Oak St', { zip: '75204' }), index)
    expect(typo.streetName).toBe('Live Oak')
    expect(typo.streetMatch).toBe('fuzzy')
    expect(typo.reasons).toContain('fuzzy_street')
    expect(typo.key).toBe(clean.key)
    expect(typo.confidence).toBeLessThan(clean.confidence)
  })

  it('G28: 5823 on another 75206 street is not the 5823 Belmont Ave home', () => {
    const belmont = keyOf(structured('5823 Belmont Ave', { zip: '75206' }))
    expect(keyOf(structured('5823 Juniper Ave', { zip: '75206' }))).not.toBe(belmont)
    expect(keyOf(structured('5823 Bellwood Ave', { zip: '75206' }))).not.toBe(belmont)
  })

  it('G19: an equally-close typo does not take either street key', () => {
    const typo = keyOf(structured('720 Pine Hll Ln', { zip: '75214' }))
    expect(typo).not.toBe(keyOf(structured('720 Pine Hill Ln', { zip: '75214' })))
    expect(typo).not.toBe(keyOf(structured('720 Pine Hall Ln', { zip: '75214' })))
  })
})

describe('hundred-block labels (R17, Q3)', () => {
  it.each(['4512 Live Oak ST', '4519 Live Oak St.', '4501 LIVE OAK ST', '4524 Live Oak Street'])(
    '%j is on the 4500 block of Live Oak St',
    (line1) => {
      const result = normalizeAddress(structured(line1, { zip: '75204' }), index)
      expect(result.blockNumber).toBe(4500)
      expect(result.blockLabel).toBe('4500 block of Live Oak St')
    },
  )

  it('puts 4599 on the 4500 block and 4600 on the 4600 block', () => {
    expect(normalizeAddress(freeText('4599 Live Oak St'), index).blockNumber).toBe(4500)
    expect(normalizeAddress(freeText('4600 Live Oak St'), index).blockNumber).toBe(4600)
  })

  it('has no block when there is no house number', () => {
    const result = normalizeAddress(freeText('Live Oak St'), index)
    expect(result.blockNumber).toBeNull()
    expect(result.blockLabel).toBeNull()
  })
})
