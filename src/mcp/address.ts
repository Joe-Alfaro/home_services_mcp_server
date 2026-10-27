import { createHash } from 'node:crypto'
import type pg from 'pg'
import { normalizeAddress, type NormalizedAddress } from '../normalize/address.ts'
import { geocode, type LatLon } from '../normalize/geocode.ts'
import { loadStreetIndex } from './db.ts'

export interface CallerAddress {
  /** What the caller typed; echoing it back is allowed (R17). */
  input: string
  normalized: NormalizedAddress
  /** Matches v_properties.address_key_hash / v_jobs.address_key_hash. */
  keyHash: string
  point: LatLon | null
  /** Why the address has no coordinates, when it has none. */
  geocodeReason: string | null
}

/**
 * Normalizes and geocodes an address the caller supplied exactly as the pipeline did the stored
 * ones (same parser, street reference and key), so the key hash finds the same home (R7, G24, G28).
 */
export async function resolveCallerAddress(pool: pg.Pool, input: string): Promise<CallerAddress> {
  const index = await loadStreetIndex(pool)
  const normalized = normalizeAddress(
    { line1: null, line2: null, city: null, state: null, zip: null, freeText: input },
    index,
  )
  const placed = geocode(normalized, index)
  return {
    input,
    normalized,
    keyHash: createHash('sha256').update(normalized.key, 'utf8').digest('hex'),
    point: placed.lat === null || placed.lon === null ? null : { lat: placed.lat, lon: placed.lon },
    geocodeReason: placed.reason,
  }
}
