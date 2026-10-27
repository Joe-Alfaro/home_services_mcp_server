import { describe, expect, it } from 'vitest'
import {
  PROVIDER_CONFIDENCE,
  resolveProviders,
  type ProviderInput,
  type ResolvedProvider,
} from '../../../src/resolve/providers.ts'
import { provider, refId } from './support.ts'

/*
 * API pinned for src/resolve/providers.ts (ARCHITECTURE "Resolution methods", D-016, R6, R8):
 *
 * export type ProviderMatchMethod = 'single_source' | 'phone' | 'email_domain' | 'website' | 'name_trade'
 * export const PROVIDER_CONFIDENCE: Readonly<Record<ProviderMatchMethod, number>>
 *   // single_source 1, phone 0.95, email_domain 0.9, website 0.9, name_trade 0.8
 * // Technician names are accepted so they can be shown as weak evidence; they are never a key (G15).
 * export type ProviderInput = ProviderCandidate & { technicianNames?: readonly string[] }
 * export interface ProviderLink {
 *   ref: SourceRef
 *   providerKey: ProviderKey
 *   method: ProviderMatchMethod // the tier that joined this candidate to its cluster
 *   confidence: number          // PROVIDER_CONFIDENCE[method]
 *   evidence: Record<string, unknown> // e.g. { phone: '2145550161' }
 * }
 * export interface ResolvedProvider {
 *   id: string
 *   displayName: string  // one of the aliases
 *   aliases: string[]    // every distinct businessName as given
 *   trades: Trade[]      // union of normalized tradesRaw (src/normalize/trade.ts)
 *   phones: string[]     // 10-digit
 *   providerKeys: ProviderKey[]
 *   links: ProviderLink[] // exactly one per input candidate
 * }
 * export interface ProviderMatchDecision {
 *   entity: 'provider'
 *   leftRef: SourceRef
 *   rightRef: SourceRef
 *   method: string
 *   score: number
 *   decision: 'accepted' | 'rejected'
 *   evidence: Record<string, unknown>
 * }
 * export interface ProviderResolution {
 *   providers: ResolvedProvider[]
 *   providerIdByKey: ReadonlyMap<ProviderKey, string>
 *   decisions: ProviderMatchDecision[]
 * }
 * export function resolveProviders(candidates: readonly ProviderInput[]): ProviderResolution
 *
 * Rules pinned here: same phone digits → merge (0.95); else same email domain (not a free-mail
 * domain) or website host → merge (0.9); else same normalized name with compatible trades (shared
 * trade, or one side has none) and no conflicting phones → merge (0.8). Merges are transitive.
 * Name similarity alone, owner names and technician names never merge.
 */

function providerOf(resolution: { providers: ResolvedProvider[] }, key: string): ResolvedProvider {
  const found = resolution.providers.filter((p) => p.providerKeys.includes(key))
  expect(found).toHaveLength(1)
  const [one] = found
  if (one === undefined) throw new Error(`no provider for ${key}`)
  return one
}

function groups(resolution: { providers: ResolvedProvider[] }): string[][] {
  return resolution.providers.map((p) => [...p.providerKeys].sort()).sort()
}

const acmeWorkiz: ProviderInput = {
  ...provider('workiz', 'acme_plumbing', {
    businessName: 'Acme Plumbing',
    phones: ['214-555-0161'],
    tradesRaw: ['plumbing'],
  }),
  technicianNames: ['Jordan Example'],
}
const acmeHcp = provider('housecall_pro', 'acme_plumbing_co_llc', {
  businessName: 'Acme Plumbing Co LLC',
  phones: ['214.555.0161'],
  emails: ['office@acmeplumbingcollc.example'],
})
const acmeProfile = provider('profiles', 'hp_901', {
  businessName: 'Acme Plumbing Co.',
  phones: ['+1 (214) 555-0161'],
  tradesRaw: ['plumbing'],
  declaredCrm: 'HCP',
})
const acmePest = provider('jobber', 'acme_termite_pest', {
  businessName: 'Acme Termite & Pest',
  phones: ['(214) 555-0162'],
  tradesRaw: ['PEST'],
})

describe('PROVIDER_CONFIDENCE (R8 (c))', () => {
  it('pins the confidence of every tier', () => {
    expect(PROVIDER_CONFIDENCE).toEqual({
      single_source: 1,
      phone: 0.95,
      email_domain: 0.9,
      website: 0.9,
      name_trade: 0.8,
    })
  })
})

describe('R6 (a), G13: one business across two CRMs and a profile', () => {
  const resolution = resolveProviders([acmeWorkiz, acmeHcp, acmeProfile, acmePest])

  it('merges the three name spellings that share one phone in three formats', () => {
    const acme = providerOf(resolution, 'workiz:acme_plumbing')
    expect([...acme.providerKeys].sort()).toEqual([
      'housecall_pro:acme_plumbing_co_llc',
      'profiles:hp_901',
      'workiz:acme_plumbing',
    ])
    expect(acme.links).toHaveLength(3)
    acme.links.forEach((link) => {
      expect(link.method).toBe('phone')
      expect(link.confidence).toBe(0.95)
      expect(link.evidence).toMatchObject({ phone: '2145550161' })
    })
    expect(acme.phones).toEqual(['2145550161'])
    expect(acme.trades).toContain('plumbing')
  })

  it('keeps every name as an alias and displays one of them', () => {
    const acme = providerOf(resolution, 'profiles:hp_901')
    expect([...acme.aliases].sort()).toEqual(
      ['Acme Plumbing', 'Acme Plumbing Co LLC', 'Acme Plumbing Co.'].sort(),
    )
    expect(acme.aliases).toContain(acme.displayName)
  })

  it('does not merge a business that only shares the name prefix', () => {
    const pest = providerOf(resolution, 'jobber:acme_termite_pest')
    expect(pest.providerKeys).toEqual(['jobber:acme_termite_pest'])
    expect(pest.trades).toEqual(['pest'])
    expect(resolution.providers).toHaveLength(2)
  })

  it('records no accepted decision between the name-prefix look-alikes', () => {
    const accepted = resolution.decisions.filter(
      (d) =>
        d.decision === 'accepted' &&
        [refId(d.leftRef), refId(d.rightRef)].includes('jobber:acme_termite_pest'),
    )
    expect(accepted).toEqual([])
  })
})

describe('G14: a rebranded business with two CRM accounts', () => {
  it('merges two differently named accounts with the same phone and keeps both names', () => {
    const resolution = resolveProviders([
      provider('jobber', 'bluejay_handyman', {
        businessName: 'Bluejay Handyman',
        ownerName: 'D. Sample',
        phones: ['2145550163'],
        tradesRaw: ['HANDYMAN'],
      }),
      provider('jobber', 'kestrel_home_repair', {
        businessName: 'Kestrel Home Repair',
        ownerName: 'Dana Sample',
        phones: ['(214) 555-0163'],
        tradesRaw: ['HANDYMAN'],
      }),
      provider('profiles', 'hp_902', {
        businessName: 'Kestrel Home Repair',
        phones: ['214-555-0163'],
        tradesRaw: ['handyman'],
      }),
    ])
    expect(resolution.providers).toHaveLength(1)
    const merged = providerOf(resolution, 'jobber:bluejay_handyman')
    expect(merged.aliases).toEqual(
      expect.arrayContaining(['Bluejay Handyman', 'Kestrel Home Repair']),
    )
    expect(new Set(merged.aliases).size).toBe(merged.aliases.length)
    expect(merged.trades).toEqual(['handyman'])
  })
})

describe('G15: person names are never a match key', () => {
  it('keeps two businesses with a shared technician but different phones and trades apart', () => {
    const resolution = resolveProviders([
      {
        ...provider('jobber', 'wren_electric', {
          businessName: 'Wren Electric',
          phones: ['214-555-0164'],
          tradesRaw: ['ELECTRICAL'],
        }),
        technicianNames: ['Jordan Example', 'Casey Example'],
      },
      {
        ...provider('housecall_pro', 'finch_maids', {
          businessName: 'Finch Maids',
          phones: ['214-555-0165'],
          tradesRaw: ['cleaning'],
        }),
        technicianNames: ['Jordan Example'],
      },
    ])
    expect(groups(resolution)).toEqual([['housecall_pro:finch_maids'], ['jobber:wren_electric']])
    resolution.decisions
      .filter((d) => d.decision === 'accepted')
      .forEach((d) => {
        expect(d.method).not.toMatch(/technician|owner|person/i)
      })
  })

  it('keeps two businesses with the same owner name but different phones and trades apart', () => {
    const resolution = resolveProviders([
      provider('workiz', 'heron_hvac', {
        businessName: 'Heron HVAC',
        ownerName: 'Jordan Example',
        phones: ['214-555-0166'],
        tradesRaw: ['hvac'],
      }),
      provider('jobber', 'osprey_lawn', {
        businessName: 'Osprey Lawn',
        ownerName: 'Jordan Example',
        phones: ['214-555-0167'],
        tradesRaw: ['LAWN'],
      }),
    ])
    expect(resolution.providers).toHaveLength(2)
  })
})

describe('email domain and website tiers (R8)', () => {
  it('merges on a shared business email domain at 0.9', () => {
    const resolution = resolveProviders([
      provider('profiles', 'hp_903', {
        businessName: 'Plover Roofing',
        emails: ['office@ploverroofing.example'],
        tradesRaw: ['roofing'],
      }),
      provider('housecall_pro', 'plover_roofing_gutters', {
        businessName: 'Plover Roofing & Gutters',
        emails: ['Sam@PloverRoofing.example'],
        phones: ['214-555-0168'],
      }),
    ])
    expect(resolution.providers).toHaveLength(1)
    const link = providerOf(resolution, 'profiles:hp_903').links.find(
      (l) => l.providerKey === 'profiles:hp_903',
    )
    expect(link).toMatchObject({
      method: 'email_domain',
      confidence: 0.9,
      evidence: { emailDomain: 'ploverroofing.example' },
    })
  })

  it('never merges on a free-mail domain', () => {
    const resolution = resolveProviders([
      provider('profiles', 'hp_904', {
        businessName: 'Robin Lawn',
        emails: ['robinlawn@gmail.com'],
        phones: ['214-555-0169'],
        tradesRaw: ['lawn'],
      }),
      provider('profiles', 'hp_905', {
        businessName: 'Swift Garage Doors',
        emails: ['swiftgarage@gmail.com'],
        phones: ['214-555-0170'],
        tradesRaw: ['garage'],
      }),
    ])
    expect(resolution.providers).toHaveLength(2)
  })

  it('merges on the same website host at 0.9', () => {
    const resolution = resolveProviders([
      provider('profiles', 'hp_906', {
        businessName: 'Tern Painting',
        website: 'https://www.ternpainting.example/',
        tradesRaw: ['painting'],
      }),
      provider('jobber', 'tern_painting_llc', {
        businessName: 'Tern Painting LLC',
        website: 'ternpainting.example',
      }),
    ])
    expect(resolution.providers).toHaveLength(1)
    const link = providerOf(resolution, 'profiles:hp_906').links.find(
      (l) => l.providerKey === 'profiles:hp_906',
    )
    expect(link).toMatchObject({ method: 'website', confidence: 0.9 })
  })

  it('merges transitively and labels each link with the tier that joined it', () => {
    const resolution = resolveProviders([
      provider('workiz', 'acme_plumbing', {
        businessName: 'Acme Plumbing',
        phones: ['2145550161'],
      }),
      provider('housecall_pro', 'acme_plumbing_co_llc', {
        businessName: 'Acme Plumbing Co LLC',
        phones: ['214.555.0161'],
        emails: ['office@acmeplumbingcollc.example'],
      }),
      provider('profiles', 'hp_901', {
        businessName: 'Acme Plumbing Co.',
        emails: ['dispatch@acmeplumbingcollc.example'],
      }),
    ])
    expect(resolution.providers).toHaveLength(1)
    const links = providerOf(resolution, 'workiz:acme_plumbing').links
    expect(links.find((l) => l.providerKey === 'workiz:acme_plumbing')?.method).toBe('phone')
    expect(links.find((l) => l.providerKey === 'profiles:hp_901')).toMatchObject({
      method: 'email_domain',
      confidence: 0.9,
    })
  })
})

describe('name + compatible trade tier (R8)', () => {
  it('links a phone-less CSV log owner to the profile with the same normalized name at 0.8', () => {
    const resolution = resolveProviders([
      provider('spreadsheet', 'dots_fixit_job_log', { businessName: "Dot's Fix-It" }),
      provider('profiles', 'hp_907', {
        businessName: 'Dots Fix It',
        phones: ['214-555-0171'],
        tradesRaw: ['handyman'],
      }),
    ])
    expect(resolution.providers).toHaveLength(1)
    const link = providerOf(resolution, 'profiles:hp_907').links.find(
      (l) => l.providerKey === 'spreadsheet:dots_fixit_job_log',
    )
    expect(link).toMatchObject({ method: 'name_trade', confidence: 0.8 })
  })

  it('does not merge the same name with incompatible trades, and records the rejection', () => {
    const resolution = resolveProviders([
      provider('profiles', 'hp_908', { businessName: 'Summit Services', tradesRaw: ['plumbing'] }),
      provider('jobber', 'summit_services', {
        businessName: 'Summit Services',
        tradesRaw: ['PEST'],
      }),
    ])
    expect(resolution.providers).toHaveLength(2)
    expect(resolution.decisions).toContainEqual(
      expect.objectContaining({ entity: 'provider', decision: 'rejected' }),
    )
  })

  it('does not merge the same name and trade when the phones conflict', () => {
    const resolution = resolveProviders([
      provider('workiz', 'summit_plumbing', {
        businessName: 'Summit Plumbing',
        phones: ['214-555-0172'],
        tradesRaw: ['plumbing'],
      }),
      provider('housecall_pro', 'summit_plumbing', {
        businessName: 'Summit Plumbing',
        phones: ['214-555-0173'],
        tradesRaw: ['plumbing'],
      }),
    ])
    expect(resolution.providers).toHaveLength(2)
    expect(resolution.decisions).toContainEqual(
      expect.objectContaining({ entity: 'provider', decision: 'rejected' }),
    )
  })
})

describe('R6 (c), R8 (a): every candidate links exactly once with a scored method', () => {
  const candidates = [acmeWorkiz, acmeHcp, acmeProfile, acmePest]
  const resolution = resolveProviders(candidates)

  it('gives every candidate exactly one link across all providers', () => {
    const linked = resolution.providers.flatMap((p) => p.links.map((l) => refId(l.ref)))
    expect(linked.sort()).toEqual(candidates.map((c) => refId(c.ref)).sort())
  })

  it('maps every provider key to its canonical provider id', () => {
    candidates.forEach((c) => {
      expect(resolution.providerIdByKey.get(c.providerKey)).toBe(
        providerOf(resolution, c.providerKey).id,
      )
    })
  })

  it('every link has a method, a confidence in [0, 1] and an evidence object', () => {
    resolution.providers
      .flatMap((p) => p.links)
      .forEach((link) => {
        expect(link.method).toEqual(expect.any(String))
        expect(link.confidence).toBeGreaterThanOrEqual(0)
        expect(link.confidence).toBeLessThanOrEqual(1)
        expect(link.evidence).toEqual(expect.any(Object))
      })
  })

  it('a provider found in one source links with method single_source at confidence 1', () => {
    expect(providerOf(resolution, 'jobber:acme_termite_pest').links).toEqual([
      expect.objectContaining({ method: 'single_source', confidence: 1 }),
    ])
  })

  it('gives the same grouping whatever the input order', () => {
    expect(groups(resolveProviders([...candidates].reverse()))).toEqual(groups(resolution))
  })

  it('returns nothing for no candidates', () => {
    expect(resolveProviders([]).providers).toEqual([])
  })
})
