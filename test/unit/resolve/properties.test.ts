import { describe, expect, it } from 'vitest'
import { normalizeAddress } from '../../../src/normalize/address.ts'
import {
  PROPERTY_CONFIDENCE,
  resolveProperties,
  type PropertyResolution,
  type ResolvedProperty,
} from '../../../src/resolve/properties.ts'
import { referenceIndex } from '../normalize/reference.ts'
import { address, property, refId } from './support.ts'

/*
 * API pinned for src/resolve/properties.ts (ARCHITECTURE "Resolution methods", R7, R8, G19, G24, G28):
 *
 * export type PropertyMatchMethod = 'exact_key' | 'inferred_zip' | 'free_text' | 'fuzzy_street'
 * // exact_key 1 (structured address, exact street, own zip); inferred_zip 0.85; free_text 0.8.
 * // fuzzy_street is < 1 and not pinned. When several apply, the lowest confidence wins.
 * export const PROPERTY_CONFIDENCE: Readonly<{ exact_key: number; inferred_zip: number; free_text: number }>
 * export interface PropertyLink {
 *   ref: SourceRef
 *   propertyKey: PropertyKey
 *   method: PropertyMatchMethod
 *   confidence: number
 *   evidence: Record<string, unknown> // includes zipInferred: boolean and streetMatch; never contact PII
 * }
 * export interface ResolvedProperty {
 *   id: string
 *   addressKey: string           // NormalizedAddress.key
 *   address: NormalizedAddress   // src/normalize/address.ts
 *   geocode: GeocodeResult       // src/normalize/geocode.ts
 *   links: PropertyLink[]        // one per input candidate
 * }
 * export interface PropertyResolution {
 *   properties: ResolvedProperty[]
 *   propertyIdByKey: ReadonlyMap<PropertyKey, string>
 *   // Homeowner PII, for the homeowner_contacts table only (R17).
 *   contacts: Array<{ propertyId: string; ref: SourceRef; contact: ContactPii }>
 * }
 * export function resolveProperties(
 *   candidates: readonly PropertyCandidate[], index: StreetIndex,
 * ): PropertyResolution
 */

const index = referenceIndex()

function propertyOf(resolution: PropertyResolution, propertyKey: string): ResolvedProperty {
  const id = resolution.propertyIdByKey.get(propertyKey)
  const found = resolution.properties.filter((p) => p.id === id)
  expect(found).toHaveLength(1)
  const [one] = found
  if (one === undefined) throw new Error(`no property for ${propertyKey}`)
  return one
}

function linkOf(resolution: PropertyResolution, propertyKey: string) {
  const link = propertyOf(resolution, propertyKey).links.find((l) => l.propertyKey === propertyKey)
  if (link === undefined) throw new Error(`no link for ${propertyKey}`)
  return link
}

describe('PROPERTY_CONFIDENCE (R8 (c))', () => {
  it('pins the confidence of each address tier', () => {
    expect(PROPERTY_CONFIDENCE).toEqual({ exact_key: 1, inferred_zip: 0.85, free_text: 0.8 })
  })
})

describe('R7: one home across sources and providers', () => {
  const resolution = resolveProperties(
    [
      property(
        'jobber',
        'bluejay_handyman',
        'P1',
        address({
          line1: '4512 Live Oak St',
          city: 'Dallas',
          state: 'Texas',
          zip: '75204-3637',
        }),
      ),
      property(
        'housecall_pro',
        'acme_plumbing_co_llc',
        'cus_7',
        address({
          line1: '4512 live oak street',
          city: 'DALLAS',
          state: 'TX',
          zip: '75204',
        }),
      ),
      property('workiz', 'acme_plumbing', 'C12', address({ line1: '4512 LIVE OAK ST' })),
      property(
        'spreadsheet',
        'dots_fixit_job_log',
        'addr-1',
        address({
          freeText: '4512 live oak st',
        }),
      ),
    ],
    index,
  )

  it('merges every spelling into one property', () => {
    expect(resolution.properties).toHaveLength(1)
    expect(resolution.properties[0]?.links).toHaveLength(4)
  })

  it('maps every source property key to that property', () => {
    const ids = new Set(
      [
        'jobber:bluejay_handyman:P1',
        'housecall_pro:acme_plumbing_co_llc:cus_7',
        'workiz:acme_plumbing:C12',
        'spreadsheet:dots_fixit_job_log:addr-1',
      ].map((key) => resolution.propertyIdByKey.get(key)),
    )
    expect(ids.size).toBe(1)
    expect(ids.has(undefined)).toBe(false)
  })

  it('pins the confidence per tier: exact key 1, inferred zip 0.85, free text ≤ 0.8', () => {
    expect(linkOf(resolution, 'jobber:bluejay_handyman:P1')).toMatchObject({
      method: 'exact_key',
      confidence: 1,
    })
    expect(linkOf(resolution, 'housecall_pro:acme_plumbing_co_llc:cus_7').confidence).toBe(1)
    expect(linkOf(resolution, 'workiz:acme_plumbing:C12')).toMatchObject({
      method: 'inferred_zip',
      confidence: 0.85,
      evidence: { zipInferred: true },
    })
    const csv = linkOf(resolution, 'spreadsheet:dots_fixit_job_log:addr-1')
    expect(csv.method).toBe('free_text')
    expect(csv.confidence).toBeLessThanOrEqual(0.8)
  })

  it('a free-text address with its own zip links at 0.8', () => {
    const single = resolveProperties(
      [
        property(
          'spreadsheet',
          'dots_fixit_job_log',
          'addr-2',
          address({
            freeText: '5823 Belmont Ave, Dallas, TX 75206',
          }),
        ),
      ],
      index,
    )
    expect(linkOf(single, 'spreadsheet:dots_fixit_job_log:addr-2')).toMatchObject({
      method: 'free_text',
      confidence: 0.8,
    })
  })

  it('stores the normalized address, hundred block and interpolated location', () => {
    const [home] = resolution.properties
    expect(home?.address).toMatchObject({
      houseNumber: '4512',
      streetName: 'Live Oak',
      streetType: 'St',
      zip: '75204',
      blockLabel: '4500 block of Live Oak St',
    })
    expect(home?.addressKey).toBe(home?.address.key)
    expect(home?.geocode.geocodeMethod).toBe('interpolated')
  })
})

describe('R7 (b), G24: units are separate homes', () => {
  it('Apt 4 and Apt 5 do not merge', () => {
    const resolution = resolveProperties(
      [
        property(
          'jobber',
          'a',
          'P1',
          address({ line1: '123 Elm St', line2: 'Apt 4', zip: '75204' }),
        ),
        property(
          'jobber',
          'a',
          'P2',
          address({ line1: '123 Elm St', line2: 'Apt 5', zip: '75204' }),
        ),
      ],
      index,
    )
    expect(resolution.properties).toHaveLength(2)
  })

  it('Apt A and Apt B are two homes; #A, A and Apt. A are one', () => {
    const resolution = resolveProperties(
      [
        property(
          'jobber',
          'a',
          'P1',
          address({ line1: '1234 Sample Ave', line2: 'Apt A', zip: '75214' }),
        ),
        property(
          'jobber',
          'a',
          'P2',
          address({ line1: '1234 Sample Ave', line2: 'Apt B', zip: '75214' }),
        ),
        property(
          'workiz',
          'b',
          'C1',
          address({ line1: '1234 Sample Ave', line2: 'A', zip: '75214' }),
        ),
        property('spreadsheet', 'c', 'addr-1', address({ freeText: '1234 Sample Ave #A' })),
        property(
          'housecall_pro',
          'd',
          'cus_1',
          address({
            line1: '1234 Sample Ave',
            line2: 'Apt. A',
            zip: '75214',
          }),
        ),
      ],
      index,
    )
    expect(resolution.properties).toHaveLength(2)
    expect(propertyOf(resolution, 'jobber:a:P1').links).toHaveLength(4)
    expect(propertyOf(resolution, 'jobber:a:P2').links).toHaveLength(1)
  })

  it('a unit and the building without a unit are separate homes', () => {
    const resolution = resolveProperties(
      [
        property(
          'jobber',
          'a',
          'P1',
          address({ line1: '123 Elm St', line2: 'Apt 4', zip: '75204' }),
        ),
        property('jobber', 'a', 'P2', address({ line1: '123 Elm St', zip: '75204' })),
      ],
      index,
    )
    expect(resolution.properties).toHaveLength(2)
  })
})

describe('G19, G28: street typos and same-number homes', () => {
  const resolution = resolveProperties(
    [
      property(
        'workiz',
        'acme_plumbing',
        'C1',
        address({ line1: '5823 Belmont Ave', zip: '75206' }),
      ),
      property(
        'housecall_pro',
        'acme_plumbing_co_llc',
        'cus_2',
        address({
          line1: '5823 BELOMNT AVE',
          zip: '75206',
        }),
      ),
      property(
        'jobber',
        'wren_electric',
        'P3',
        address({ line1: '5823 Juniper Ave', zip: '75206' }),
      ),
    ],
    index,
  )

  it('merges a one-transposition typo into the reference street with confidence < 1', () => {
    expect(resolution.propertyIdByKey.get('housecall_pro:acme_plumbing_co_llc:cus_2')).toBe(
      resolution.propertyIdByKey.get('workiz:acme_plumbing:C1'),
    )
    const link = linkOf(resolution, 'housecall_pro:acme_plumbing_co_llc:cus_2')
    expect(link.method).toBe('fuzzy_street')
    expect(link.confidence).toBeLessThan(1)
    expect(link.confidence).toBeGreaterThan(0)
    expect(link.evidence).toMatchObject({ streetMatch: 'fuzzy' })
  })

  it('keeps the same house number on another street in the same zip apart', () => {
    expect(resolution.properties).toHaveLength(2)
    expect(resolution.propertyIdByKey.get('jobber:wren_electric:P3')).not.toBe(
      resolution.propertyIdByKey.get('workiz:acme_plumbing:C1'),
    )
  })

  it('a Q5-style lookup key finds the Belmont home, not the Juniper one', () => {
    const query = normalizeAddress(
      address({ freeText: '5823 Belmont Ave, Dallas, TX 75206' }),
      index,
    ).key
    const matches = resolution.properties.filter((p) => p.addressKey === query)
    expect(matches).toHaveLength(1)
    expect(matches[0]?.links.map((l) => refId(l.ref)).sort()).toEqual(
      ['housecall_pro:cus_2#address', 'workiz:C1#address'].sort(),
    )
  })
})

describe('R7 (c) and (e), G22, G24: zips, ambiguity and out-of-area homes', () => {
  it('a zip-less record of a unique street joins the zipped home', () => {
    const resolution = resolveProperties(
      [
        property('jobber', 'a', 'P1', address({ line1: '123 Elm St', zip: '75204' })),
        property('workiz', 'b', 'C1', address({ line1: '123 Elm Street' })),
      ],
      index,
    )
    expect(resolution.properties).toHaveLength(1)
  })

  it('a zip-less street that exists in two zips does not join either zipped home', () => {
    const resolution = resolveProperties(
      [
        property('jobber', 'a', 'P1', address({ line1: '350 Glade Dr', zip: '75041' })),
        property('jobber', 'a', 'P2', address({ line1: '350 Glade Dr', zip: '75080' })),
        property('workiz', 'b', 'C1', address({ line1: '350 Glade Dr' })),
      ],
      index,
    )
    expect(resolution.properties).toHaveLength(3)
    expect(propertyOf(resolution, 'workiz:b:C1').geocode).toMatchObject({
      geocodeMethod: 'none',
      reason: 'ambiguous_street',
    })
  })

  it('keeps out-of-area homes, one per zip, with geocode_method none', () => {
    const resolution = resolveProperties(
      [
        property(
          'housecall_pro',
          'a',
          'cus_1',
          address({ line1: '100 Prairie Wind Dr', zip: '75034' }),
        ),
        property(
          'housecall_pro',
          'a',
          'cus_2',
          address({ line1: '100 Prairie Wind Dr', zip: '75019' }),
        ),
      ],
      index,
    )
    expect(resolution.properties).toHaveLength(2)
    resolution.properties.forEach((p) => {
      expect(p.geocode.geocodeMethod).toBe('none')
      expect(p.geocode.inTargetZip).toBe(false)
    })
  })
})

describe('R8 (a), R17: links are scored and PII stays in contacts', () => {
  const contact = {
    sourceCustomerId: 'cus_9',
    name: 'Alex Sample',
    phones: ['214-555-0190'],
    emails: ['alex.sample@example.com'],
  }
  const resolution = resolveProperties(
    [
      property(
        'housecall_pro',
        'acme_plumbing_co_llc',
        'cus_9',
        address({ line1: '5823 Belmont Ave', zip: '75206' }),
        contact,
      ),
      property(
        'spreadsheet',
        'dots_fixit_job_log',
        'addr-9',
        address({
          freeText: '5823 belmont ave',
        }),
      ),
    ],
    index,
  )

  it('every link has a method, a confidence in [0, 1] and an evidence object', () => {
    resolution.properties
      .flatMap((p) => p.links)
      .forEach((link) => {
        expect(link.method).toEqual(expect.any(String))
        expect(link.confidence).toBeGreaterThanOrEqual(0)
        expect(link.confidence).toBeLessThanOrEqual(1)
        expect(link.evidence).toEqual(expect.any(Object))
      })
  })

  it('routes homeowner contact details to contacts with the property id', () => {
    expect(resolution.contacts).toHaveLength(1)
    expect(resolution.contacts[0]).toMatchObject({
      propertyId: resolution.propertyIdByKey.get('housecall_pro:acme_plumbing_co_llc:cus_9'),
      ref: { sourceRecordId: 'cus_9#address' },
      contact,
    })
  })

  it('keeps names, phones and emails out of the properties and their link evidence', () => {
    const text = JSON.stringify(resolution.properties)
    expect(text).not.toContain('Alex')
    expect(text).not.toContain('Sample')
    expect(text).not.toContain('555-0190')
    expect(text).not.toContain('example.com')
  })

  it('returns nothing for no candidates', () => {
    expect(resolveProperties([], index).properties).toEqual([])
  })
})
