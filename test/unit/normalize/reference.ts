import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RawAddress } from '../../../src/adapters/types.ts'
import {
  createStreetIndex,
  parseStreetSegmentsCsv,
  type StreetIndex,
} from '../../../src/normalize/geocode.ts'

/*
 * Shared helpers for the M1 address, geocode and resolver tests.
 *
 * test/fixtures/reference/street_segments.csv is invented and has the same columns as the data
 * pack's reference/street_segments.csv. Target zips are the zips it contains:
 * 75204 (Live Oak St 4400-4699, Elm St 100-199), 75206 (Belmont Ave and Juniper Ave 5800-5899),
 * 75214 (Sample Ave 1200-1299, Pine Hill Ln and Pine Hall Ln 700-799), and Glade Dr 300-399 in both
 * 75041 and 75080 (one street name in two zips).
 */

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/reference/street_segments.csv',
)

export function referenceCsv(): string {
  return readFileSync(FIXTURE, 'utf8')
}

export function referenceIndex(): StreetIndex {
  return createStreetIndex(parseStreetSegmentsCsv(referenceCsv()))
}

/** A structured address as a CRM adapter would emit it. */
export function structured(
  line1: string,
  fields: Partial<Omit<RawAddress, 'line1' | 'freeText'>> = {},
): RawAddress {
  return {
    line1,
    line2: fields.line2 ?? null,
    city: fields.city ?? null,
    state: fields.state ?? null,
    zip: fields.zip ?? null,
    freeText: null,
  }
}

/** A single free-text address as the CSV and ICS adapters emit it. */
export function freeText(text: string): RawAddress {
  return { line1: null, line2: null, city: null, state: null, zip: null, freeText: text }
}

/** Planar distance in metres, good to millimetres over a few hundred metres. Independent of src. */
export function approxMetres(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dy = (a.lat - b.lat) * 110_574
  const dx = (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180)
  return Math.hypot(dx, dy)
}
