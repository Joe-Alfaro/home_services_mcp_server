import { parse } from 'csv-parse/sync'
import type { NormalizedAddress } from './address.ts'

export interface StreetSegment {
  streetName: string
  streetType: string
  city: string
  state: string
  zip: string
  fromNumber: number
  toNumber: number
  startLat: number
  startLon: number
  endLat: number
  endLon: number
}

export interface StreetIndex {
  readonly segments: readonly StreetSegment[]
  /** Every zip in the reference (R7 target zips). */
  readonly targetZips: ReadonlySet<string>
}

export interface LatLon {
  lat: number
  lon: number
}

export type GeocodeReason =
  | 'outside_reference'
  | 'ambiguous_street'
  | 'unknown_street'
  | 'number_out_of_range'
  | 'missing_number'

export interface GeocodeResult {
  lat: number | null
  lon: number | null
  geocodeMethod: 'interpolated' | 'none'
  inTargetZip: boolean
  reason: GeocodeReason | null
  segment: StreetSegment | null
}

export const HALF_MILE_METERS = 804.7
const EARTH_RADIUS_METERS = 6_371_000

function requiredNumber(row: Record<string, string>, column: string): number {
  const value = Number(row[column])
  if (row[column] === undefined || row[column].trim() === '' || !Number.isFinite(value)) {
    throw new Error(`street segment row has no numeric ${column}`)
  }
  return value
}

/** Reads the reference CSV (street_name,street_type,city,state,zip,from_number,...). */
export function parseStreetSegmentsCsv(csv: string): StreetSegment[] {
  const rows: Record<string, string>[] = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  })
  return rows.map((row) => ({
    streetName: row.street_name ?? '',
    streetType: row.street_type ?? '',
    city: row.city ?? '',
    state: row.state ?? '',
    zip: row.zip ?? '',
    fromNumber: requiredNumber(row, 'from_number'),
    toNumber: requiredNumber(row, 'to_number'),
    startLat: requiredNumber(row, 'start_lat'),
    startLon: requiredNumber(row, 'start_lon'),
    endLat: requiredNumber(row, 'end_lat'),
    endLon: requiredNumber(row, 'end_lon'),
  }))
}

export function createStreetIndex(segments: readonly StreetSegment[]): StreetIndex {
  return { segments, targetZips: new Set(segments.map((segment) => segment.zip)) }
}

/** True when the segment is the given street (case-insensitive) and holds the house number. */
export function segmentHolds(
  segment: StreetSegment,
  streetName: string,
  streetType: string | null,
  houseNumber: number,
): boolean {
  return (
    segment.streetName.toLowerCase() === streetName.toLowerCase() &&
    (streetType === null || segment.streetType.toLowerCase() === streetType.toLowerCase()) &&
    houseNumber >= Math.min(segment.fromNumber, segment.toNumber) &&
    houseNumber <= Math.max(segment.fromNumber, segment.toNumber)
  )
}

/** Linear interpolation of the house number along its block; fraction in [0, 1]. */
export function interpolate(
  segment: StreetSegment,
  houseNumber: number,
): LatLon & { fraction: number } {
  const span = segment.toNumber - segment.fromNumber
  // A 4500-4599 block has 100 numbers, so 4550 is the midpoint and 4512 is 12% along.
  const raw = span === 0 ? 0 : (houseNumber - segment.fromNumber) / (span + Math.sign(span))
  const fraction = Math.min(1, Math.max(0, raw))
  return {
    lat: segment.startLat + fraction * (segment.endLat - segment.startLat),
    lon: segment.startLon + fraction * (segment.endLon - segment.startLon),
    fraction,
  }
}

function unplaced(inTargetZip: boolean, reason: GeocodeReason): GeocodeResult {
  return { lat: null, lon: null, geocodeMethod: 'none', inTargetZip, reason, segment: null }
}

/** Places a normalized address on its reference street segment, or says why it can't. */
export function geocode(address: NormalizedAddress, index: StreetIndex): GeocodeResult {
  const inTargetZip = address.zip !== null && index.targetZips.has(address.zip)
  if (address.zip !== null && !inTargetZip) return unplaced(false, 'outside_reference')
  if (address.streetMatch === 'ambiguous') return unplaced(inTargetZip, 'ambiguous_street')
  const houseNumber = address.houseNumber === null ? NaN : Number.parseInt(address.houseNumber, 10)
  if (Number.isNaN(houseNumber)) return unplaced(inTargetZip, 'missing_number')
  if (address.streetMatch === 'none' || address.streetName === null) {
    return unplaced(inTargetZip, 'unknown_street')
  }
  const { streetName, streetType, zip } = address
  const segments = index.segments.filter(
    (segment) =>
      (zip === null || segment.zip === zip) &&
      segmentHolds(segment, streetName, streetType, houseNumber),
  )
  const [segment] = segments
  if (segment === undefined) return unplaced(inTargetZip, 'number_out_of_range')
  if (segments.length > 1) return unplaced(inTargetZip, 'ambiguous_street')
  const point = interpolate(segment, houseNumber)
  return {
    lat: point.lat,
    lon: point.lon,
    geocodeMethod: 'interpolated',
    inTargetZip: index.targetZips.has(segment.zip),
    reason: null,
    segment,
  }
}

export function haversineMeters(a: LatLon, b: LatLon): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180
  const dLat = toRadians(b.lat - a.lat)
  const dLon = toRadians(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Inclusive: distance <= radius. */
export function isWithinRadius(
  origin: LatLon,
  point: LatLon,
  radiusMeters: number = HALF_MILE_METERS,
): boolean {
  return haversineMeters(origin, point) <= radiusMeters
}
