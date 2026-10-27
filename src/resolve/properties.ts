import type { ContactPii, PropertyCandidate, PropertyKey, SourceRef } from '../adapters/types.ts'
import {
  FREE_TEXT_CONFIDENCE,
  INFERRED_ZIP_CONFIDENCE,
  normalizeAddress,
  type NormalizedAddress,
} from '../normalize/address.ts'
import { geocode, type GeocodeResult, type StreetIndex } from '../normalize/geocode.ts'
import { compareText, refKey, stableId } from './ids.ts'

export type PropertyMatchMethod = 'exact_key' | 'inferred_zip' | 'free_text' | 'fuzzy_street'

/** R8 (c), D-046. fuzzy_street takes the street match's own confidence (< 1). */
export const PROPERTY_CONFIDENCE: Readonly<{
  exact_key: number
  inferred_zip: number
  free_text: number
}> = {
  exact_key: 1,
  inferred_zip: INFERRED_ZIP_CONFIDENCE,
  free_text: FREE_TEXT_CONFIDENCE,
}

export interface PropertyLink {
  ref: SourceRef
  propertyKey: PropertyKey
  method: PropertyMatchMethod
  confidence: number
  /** zipInferred, streetMatch and reasons; never contact PII. */
  evidence: Record<string, unknown>
}

export interface ResolvedProperty {
  id: string
  addressKey: string
  address: NormalizedAddress
  geocode: GeocodeResult
  /** One per input candidate. */
  links: PropertyLink[]
}

export interface PropertyResolution {
  properties: ResolvedProperty[]
  propertyIdByKey: ReadonlyMap<PropertyKey, string>
  /** Homeowner PII, for the homeowner_contacts table only (R17). */
  contacts: Array<{ propertyId: string; ref: SourceRef; contact: ContactPii }>
}

interface Normalized {
  candidate: PropertyCandidate
  address: NormalizedAddress
  method: PropertyMatchMethod
  confidence: number
}

/** Every tier that applies, lowest confidence wins (D-046). */
function scoreLink(address: NormalizedAddress): {
  method: PropertyMatchMethod
  confidence: number
} {
  const tiers: Array<{ method: PropertyMatchMethod; confidence: number }> = [
    { method: 'exact_key', confidence: PROPERTY_CONFIDENCE.exact_key },
  ]
  if (address.streetMatch === 'fuzzy') {
    tiers.push({ method: 'fuzzy_street', confidence: Math.min(address.confidence, 0.99) })
  }
  if (address.zipInferred) {
    tiers.push({ method: 'inferred_zip', confidence: PROPERTY_CONFIDENCE.inferred_zip })
  }
  if (address.reasons.includes('free_text')) {
    tiers.push({ method: 'free_text', confidence: PROPERTY_CONFIDENCE.free_text })
  }
  return tiers.reduce((lowest, tier) => (tier.confidence <= lowest.confidence ? tier : lowest))
}

/**
 * The grouping key. An address without a house number or street can't identify a home, so it
 * stays its own property rather than collapsing with every other blank address.
 */
function groupKey(item: Normalized): string {
  const { address, candidate } = item
  if (address.houseNumber === null || address.streetName === null) {
    return `${address.key}#${candidate.propertyKey}`
  }
  return address.key
}

/**
 * Merges property candidates that normalize to one address key (R7, D-046). Units are part of
 * the key, so different units never merge. Contacts are split off for the PII table.
 */
export function resolveProperties(
  candidates: readonly PropertyCandidate[],
  index: StreetIndex,
): PropertyResolution {
  const normalized = [...candidates]
    .sort(
      (a, b) =>
        compareText(a.propertyKey, b.propertyKey) || compareText(refKey(a.ref), refKey(b.ref)),
    )
    .map((candidate): Normalized => {
      const address = normalizeAddress(candidate.address, index)
      return { candidate, address, ...scoreLink(address) }
    })

  const groups = new Map<string, Normalized[]>()
  normalized.forEach((item) => {
    const key = groupKey(item)
    groups.set(key, [...(groups.get(key) ?? []), item])
  })

  const properties = [...groups.entries()].map(([key, items]): ResolvedProperty => {
    // The most confident spelling represents the home.
    const best = items.reduce((top, item) => (item.confidence > top.confidence ? item : top))
    return {
      id: stableId('prop', key),
      addressKey: best.address.key,
      address: best.address,
      geocode: geocode(best.address, index),
      links: items.map((item) => ({
        ref: item.candidate.ref,
        propertyKey: item.candidate.propertyKey,
        method: item.method,
        confidence: item.confidence,
        evidence: {
          zipInferred: item.address.zipInferred,
          streetMatch: item.address.streetMatch,
          reasons: item.address.reasons,
        },
      })),
    }
  })

  const propertyIdByKey = new Map(
    properties.flatMap((property) =>
      property.links.map((link) => [link.propertyKey, property.id] as const),
    ),
  )
  const contacts = normalized.flatMap((item) => {
    const propertyId = propertyIdByKey.get(item.candidate.propertyKey)
    const contact = item.candidate.contact
    if (propertyId === undefined || contact === null) return []
    return [{ propertyId, ref: item.candidate.ref, contact }]
  })
  return { properties, propertyIdByKey, contacts }
}
