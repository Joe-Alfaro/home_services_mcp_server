import { describe, expect, it } from 'vitest'
import { normalizeAddress } from '../../../src/normalize/address.ts'
import {
  HALF_MILE_METERS,
  createStreetIndex,
  geocode,
  haversineMeters,
  interpolate,
  isWithinRadius,
  parseStreetSegmentsCsv,
} from '../../../src/normalize/geocode.ts'
import { approxMetres, freeText, referenceCsv, referenceIndex, structured } from './reference.ts'

/*
 * API pinned for src/normalize/geocode.ts (NormalizedAddress is from src/normalize/address.ts):
 *
 * export interface StreetSegment {
 *   streetName: string; streetType: string; city: string; state: string; zip: string
 *   fromNumber: number; toNumber: number
 *   startLat: number; startLon: number; endLat: number; endLon: number
 * }
 * // Reads the reference CSV (header street_name,street_type,city,state,zip,from_number,...).
 * export function parseStreetSegmentsCsv(csv: string): StreetSegment[]
 * export interface StreetIndex {
 *   readonly segments: readonly StreetSegment[]
 *   readonly targetZips: ReadonlySet<string> // every zip in the reference
 * }
 * export function createStreetIndex(segments: readonly StreetSegment[]): StreetIndex
 *
 * export interface LatLon { lat: number; lon: number }
 * // Linear interpolation of the house number along its block; fraction in [0, 1].
 * export function interpolate(segment: StreetSegment, houseNumber: number): LatLon & { fraction: number }
 *
 * export type GeocodeReason =
 *   'outside_reference' | 'ambiguous_street' | 'unknown_street' | 'number_out_of_range' | 'missing_number'
 * export interface GeocodeResult {
 *   lat: number | null; lon: number | null
 *   geocodeMethod: 'interpolated' | 'none'
 *   inTargetZip: boolean
 *   reason: GeocodeReason | null // null when interpolated
 *   segment: StreetSegment | null
 * }
 * export function geocode(address: NormalizedAddress, index: StreetIndex): GeocodeResult
 *
 * export const HALF_MILE_METERS = 804.7
 * export function haversineMeters(a: LatLon, b: LatLon): number
 * // Inclusive: distance <= radius. Default radius HALF_MILE_METERS.
 * export function isWithinRadius(origin: LatLon, point: LatLon, radiusMeters?: number): boolean
 */

const index = referenceIndex()

function geocodeRaw(raw: Parameters<typeof normalizeAddress>[0]) {
  return geocode(normalizeAddress(raw, index), index)
}

describe('parseStreetSegmentsCsv and createStreetIndex (R3)', () => {
  it('reads every row of the reference with numeric ranges and coordinates', () => {
    const segments = parseStreetSegmentsCsv(referenceCsv())
    expect(segments).toHaveLength(11)
    expect(segments[1]).toEqual({
      streetName: 'Live Oak',
      streetType: 'St',
      city: 'Dallas',
      state: 'TX',
      zip: '75204',
      fromNumber: 4500,
      toNumber: 4599,
      startLat: 32.801,
      startLon: -96.783718,
      endLat: 32.801,
      endLon: -96.782436,
    })
  })

  it('treats every zip in the reference as a target zip', () => {
    expect([...index.targetZips].sort()).toEqual(['75041', '75080', '75204', '75206', '75214'])
  })

  it('builds an index from an empty reference without throwing', () => {
    expect(createStreetIndex([]).segments).toHaveLength(0)
  })
})

describe('R7 (d): interpolation along the street segment', () => {
  const segments = parseStreetSegmentsCsv(referenceCsv())
  const block4500 = segments[1]

  it('4550 on a 4500-4599 segment is the segment midpoint within 1 m', () => {
    if (block4500 === undefined) throw new Error('fixture row missing')
    const point = interpolate(block4500, 4550)
    const midpoint = {
      lat: (block4500.startLat + block4500.endLat) / 2,
      lon: (block4500.startLon + block4500.endLon) / 2,
    }
    expect(approxMetres(point, midpoint)).toBeLessThan(1)
  })

  it('G22: 4512 Live Oak St 75204 is interpolated about 12% along the 4500 block', () => {
    const result = geocodeRaw(structured('4512 Live Oak St', { zip: '75204' }))
    expect(result.geocodeMethod).toBe('interpolated')
    expect(result.reason).toBeNull()
    expect(result.inTargetZip).toBe(true)
    expect(result.segment?.fromNumber).toBe(4500)
    const expected = { lat: 32.801, lon: -96.783718 + 0.12 * (-96.782436 - -96.783718) }
    expect(approxMetres({ lat: result.lat ?? 0, lon: result.lon ?? 0 }, expected)).toBeLessThan(1)
  })

  it('reports the fraction along the block', () => {
    if (block4500 === undefined) throw new Error('fixture row missing')
    expect(interpolate(block4500, 4512).fraction).toBeCloseTo(0.12, 2)
    expect(interpolate(block4500, 4500).fraction).toBe(0)
  })

  it('geocodes a zip-less address once its zip is inferred', () => {
    const result = geocodeRaw(freeText('4550 live oak street'))
    expect(result.geocodeMethod).toBe('interpolated')
    expect(result.inTargetZip).toBe(true)
  })

  it('geocodes a fuzzy-matched street (G19)', () => {
    expect(geocodeRaw(structured('5823 Belomnt Ave', { zip: '75206' })).geocodeMethod).toBe(
      'interpolated',
    )
  })
})

describe("R7 (e), G22, G26: addresses the reference can't place", () => {
  it('an address outside the target zips gets geocode_method none and is kept', () => {
    const result = geocodeRaw(structured('100 Prairie Wind Dr', { city: 'Frisco', zip: '75034' }))
    expect(result).toMatchObject({
      lat: null,
      lon: null,
      geocodeMethod: 'none',
      inTargetZip: false,
      reason: 'outside_reference',
    })
  })

  it('a zip-less street present in two zips is unmatched with reason ambiguous_street', () => {
    const result = geocodeRaw(structured('350 Glade Dr'))
    expect(result.geocodeMethod).toBe('none')
    expect(result.reason).toBe('ambiguous_street')
    expect(result.lat).toBeNull()
  })

  it('a house number outside every block of a known street is not placed', () => {
    const result = geocodeRaw(structured('4950 Live Oak St', { zip: '75204' }))
    expect(result.geocodeMethod).toBe('none')
    expect(result.reason).toBe('number_out_of_range')
    expect(result.inTargetZip).toBe(true)
  })

  it('an unknown street in a target zip is not placed', () => {
    const result = geocodeRaw(structured('4512 Nowhere Ln', { zip: '75204' }))
    expect(result.geocodeMethod).toBe('none')
    expect(result.reason).toBe('unknown_street')
  })

  it('an address without a house number is not placed', () => {
    const result = geocodeRaw(freeText('Live Oak St, 75204'))
    expect(result.geocodeMethod).toBe('none')
    expect(result.reason).toBe('missing_number')
  })
})

describe('haversineMeters and the half-mile radius (Q1)', () => {
  // 1 degree of latitude on a 6,371 km sphere is about 111,195 m.
  const METRES_PER_DEGREE_LAT = 111_195
  const origin = { lat: 32.8, lon: -96.8 }

  function north(metres: number) {
    return { lat: origin.lat + metres / METRES_PER_DEGREE_LAT, lon: origin.lon }
  }

  it('pins half a mile as 804.7 m', () => {
    expect(HALF_MILE_METERS).toBe(804.7)
  })

  it('measures great-circle distance in metres', () => {
    expect(haversineMeters(origin, origin)).toBe(0)
    expect(haversineMeters({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeGreaterThan(110_900)
    expect(haversineMeters({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeLessThan(111_500)
    expect(haversineMeters(origin, north(500))).toBeCloseTo(500, -1)
  })

  it('is symmetric', () => {
    const a = { lat: 32.801, lon: -96.7836 }
    const b = { lat: 32.82, lon: -96.77 }
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6)
  })

  it('800 m is inside half a mile and 810 m is outside', () => {
    expect(isWithinRadius(origin, north(800))).toBe(true)
    expect(isWithinRadius(origin, north(810))).toBe(false)
  })

  it('the radius boundary is inclusive', () => {
    const point = north(804.7)
    expect(isWithinRadius(origin, point, haversineMeters(origin, point))).toBe(true)
  })

  it('accepts an explicit radius', () => {
    expect(isWithinRadius(origin, north(1500), 1609.3)).toBe(true)
    expect(isWithinRadius(origin, north(1500), 1000)).toBe(false)
  })
})
