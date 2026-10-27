import type { ProviderCandidate, ProviderKey, SourceRef } from '../adapters/types.ts'
import { emailDomain, normalizeBusinessName, websiteHost } from '../normalize/name.ts'
import { normalizePhone } from '../normalize/phone.ts'
import { normalizeTrade, type Trade } from '../normalize/trade.ts'
import { UnionFind, compareText, refKey, stableId } from './ids.ts'

type KeyedMethod = 'single_source' | 'phone' | 'email_domain' | 'website' | 'name_trade'
export type ProviderMatchMethod = KeyedMethod | 'calendar_owner'

/** R8 (c), D-045. */
export const PROVIDER_CONFIDENCE: Readonly<Record<KeyedMethod, number>> = {
  single_source: 1,
  phone: 0.95,
  email_domain: 0.9,
  website: 0.9,
  name_trade: 0.8,
}

/**
 * A calendar export carries only its owner's name (X-WR-CALNAME), so it joins the one provider
 * whose owner has that name. Owner names still never merge two businesses (G15).
 */
export const CALENDAR_OWNER_CONFIDENCE = 0.8

function confidenceOf(method: ProviderMatchMethod): number {
  return method === 'calendar_owner' ? CALENDAR_OWNER_CONFIDENCE : PROVIDER_CONFIDENCE[method]
}

/** Technician names are accepted so they can be shown as weak evidence; never a key (G15). */
export type ProviderInput = ProviderCandidate & { technicianNames?: readonly string[] }

export interface ProviderLink {
  ref: SourceRef
  providerKey: ProviderKey
  /** The tier that joined this candidate to its cluster. */
  method: ProviderMatchMethod
  confidence: number
  evidence: Record<string, unknown>
}

export interface ResolvedProvider {
  id: string
  displayName: string
  /** Every distinct businessName as given. */
  aliases: string[]
  /** Union of normalized trades, profile trades first. */
  trades: Trade[]
  /** Union of normalized does-not-do trades (profiles). */
  doesNotDo: Trade[]
  /** 10-digit business phones. */
  phones: string[]
  providerKeys: ProviderKey[]
  /** Exactly one per input candidate. */
  links: ProviderLink[]
}

export interface ProviderMatchDecision {
  entity: 'provider'
  leftRef: SourceRef
  rightRef: SourceRef
  method: string
  score: number
  decision: 'accepted' | 'rejected'
  evidence: Record<string, unknown>
}

export interface ProviderResolution {
  providers: ResolvedProvider[]
  providerIdByKey: ReadonlyMap<ProviderKey, string>
  decisions: ProviderMatchDecision[]
}

/** Shared consumer mail domains say nothing about which business owns an address. */
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'att.net',
  'sbcglobal.net',
  'comcast.net',
  'verizon.net',
  'protonmail.com',
  'proton.me',
  'mail.com',
  'gmx.com',
])

interface Prepared {
  input: ProviderInput
  phones: Set<string>
  domains: Set<string>
  host: string | null
  name: string
  /** Normalized person name: the owner, or for a calendar its name without "(work)" notes. */
  personName: string | null
  trades: Trade[]
  doesNotDo: Trade[]
}

function trades(raw: readonly string[]): Trade[] {
  return [...new Set(raw.map((value) => normalizeTrade(value)).filter((trade) => trade !== null))]
}

function prepare(input: ProviderInput): Prepared {
  return {
    input,
    phones: new Set(input.phones.map((phone) => normalizePhone(phone)).filter((p) => p !== null)),
    domains: new Set(
      input.emails
        .map((email) => emailDomain(email))
        .filter((domain): domain is string => domain !== null && !FREE_MAIL_DOMAINS.has(domain)),
    ),
    host: websiteHost(input.website),
    name: normalizeBusinessName(input.businessName),
    personName:
      input.ownerName === null
        ? null
        : normalizeBusinessName(input.ownerName.replace(/\(.*?\)/g, '')),
    trades: trades(input.tradesRaw),
    doesNotDo: trades(input.doesNotDoRaw),
  }
}

function firstShared(a: ReadonlySet<string>, b: ReadonlySet<string>): string | undefined {
  return [...a].sort().find((value) => b.has(value))
}

/** A key test for one tier: the evidence when the pair shares the key, else null. */
type TierKey = (a: Prepared, b: Prepared) => Record<string, unknown> | null

const KEY_TIERS: ReadonlyArray<[ProviderMatchMethod, TierKey]> = [
  [
    'phone',
    (a, b) => {
      const phone = firstShared(a.phones, b.phones)
      return phone === undefined ? null : { phone }
    },
  ],
  [
    'email_domain',
    (a, b) => {
      const domain = firstShared(a.domains, b.domains)
      return domain === undefined ? null : { emailDomain: domain }
    },
  ],
  ['website', (a, b) => (a.host !== null && a.host === b.host ? { websiteHost: a.host } : null)],
]

function pairs(size: number): Array<[number, number]> {
  return Array.from({ length: size }, (_, i) =>
    Array.from({ length: size - i - 1 }, (_, k): [number, number] => [i, i + k + 1]),
  ).flat()
}

/**
 * Clusters provider candidates (D-016, D-045): same phone digits 0.95; same business email
 * domain or website host 0.9; same normalized name with compatible trades and no conflicting
 * phones 0.8. Clusters are transitive. Owner and technician names never merge two businesses; a
 * keyless calendar joins the single provider whose owner it is named after (0.8).
 */
export function resolveProviders(candidates: readonly ProviderInput[]): ProviderResolution {
  const prepared = [...candidates]
    .sort(
      (a, b) =>
        compareText(a.providerKey, b.providerKey) || compareText(refKey(a.ref), refKey(b.ref)),
    )
    .map(prepare)
  const sets = new UnionFind(prepared.length)
  const joinedBy = new Map<
    number,
    { method: ProviderMatchMethod; evidence: Record<string, unknown> }
  >()
  const decisions: ProviderMatchDecision[] = []

  function decide(
    i: number,
    j: number,
    method: ProviderMatchMethod,
    decision: 'accepted' | 'rejected',
    evidence: Record<string, unknown>,
  ) {
    const left = prepared[i]
    const right = prepared[j]
    if (left === undefined || right === undefined) return
    decisions.push({
      entity: 'provider',
      leftRef: left.input.ref,
      rightRef: right.input.ref,
      method,
      score: confidenceOf(method),
      decision,
      evidence,
    })
  }

  function join(
    i: number,
    j: number,
    method: ProviderMatchMethod,
    evidence: Record<string, unknown>,
  ) {
    if (!sets.union(i, j)) return
    // Only a candidate still on its own takes this tier; earlier members keep theirs.
    if (!joinedBy.has(i)) joinedBy.set(i, { method, evidence })
    if (!joinedBy.has(j)) joinedBy.set(j, { method, evidence })
    decide(i, j, method, 'accepted', evidence)
  }

  KEY_TIERS.forEach(([method, keyOf]) => {
    pairs(prepared.length).forEach(([i, j]) => {
      const a = prepared[i]
      const b = prepared[j]
      if (a === undefined || b === undefined) return
      const evidence = keyOf(a, b)
      if (evidence !== null) join(i, j, method, evidence)
    })
  })

  function clusterOf(i: number): Prepared[] {
    const root = sets.find(i)
    return prepared.filter((_, k) => sets.find(k) === root)
  }

  pairs(prepared.length).forEach(([i, j]) => {
    const a = prepared[i]
    const b = prepared[j]
    if (a === undefined || b === undefined || a.name === '' || a.name !== b.name) return
    if (sets.find(i) === sets.find(j)) return
    const left = clusterOf(i)
    const right = clusterOf(j)
    const leftTrades = new Set(left.flatMap((p) => p.trades))
    const rightTrades = new Set(right.flatMap((p) => p.trades))
    const leftPhones = new Set(left.flatMap((p) => [...p.phones]))
    const rightPhones = new Set(right.flatMap((p) => [...p.phones]))
    const tradesCompatible =
      leftTrades.size === 0 ||
      rightTrades.size === 0 ||
      firstShared(leftTrades, rightTrades) !== undefined
    const phonesConflict =
      leftPhones.size > 0 &&
      rightPhones.size > 0 &&
      firstShared(leftPhones, rightPhones) === undefined
    const evidence = { normalizedName: a.name }
    if (tradesCompatible && !phonesConflict) {
      join(i, j, 'name_trade', evidence)
      return
    }
    decide(i, j, 'name_trade', 'rejected', {
      ...evidence,
      reason: tradesCompatible ? 'conflicting_phones' : 'incompatible_trades',
    })
  })

  // A candidate with no business keys (a calendar) joins the one cluster whose owner it names.
  prepared.forEach((item, i) => {
    const keyless = item.phones.size === 0 && item.domains.size === 0 && item.host === null
    if (!keyless || item.input.ownerName !== null || clusterOf(i).length > 1) return
    const calendarName = normalizeBusinessName(item.input.businessName.replace(/\(.*?\)/g, ''))
    if (calendarName === '') return
    const owners = prepared
      .map((other, k) => ({ other, k }))
      .filter(({ other, k }) => k !== i && other.personName === calendarName)
    const roots = new Set(owners.map(({ k }) => sets.find(k)))
    const [owner] = owners
    if (owner === undefined) return
    const evidence = { matchedOn: 'owner_name' }
    if (roots.size > 1) {
      decide(i, owner.k, 'calendar_owner', 'rejected', { ...evidence, reason: 'ambiguous_owner' })
      return
    }
    join(i, owner.k, 'calendar_owner', evidence)
  })

  const clusters = new Map<number, number[]>()
  prepared.forEach((_, i) => {
    const root = sets.find(i)
    clusters.set(root, [...(clusters.get(root) ?? []), i])
  })

  const providers = [...clusters.values()].map((members): ResolvedProvider => {
    const items = members.map((i) => prepared[i]).filter((p) => p !== undefined)
    // Profiles describe the business as it presents itself, so their names and trades lead.
    const ordered = [
      ...items.filter((p) => p.input.ref.sourceSystem === 'profiles'),
      ...items.filter((p) => p.input.ref.sourceSystem !== 'profiles'),
    ]
    const aliases = [...new Set(ordered.map((p) => p.input.businessName))]
    const providerKeys = [...new Set(items.map((p) => p.input.providerKey))]
    return {
      id: stableId('prov', providerKeys[0] ?? ''),
      displayName: aliases[0] ?? '',
      aliases,
      trades: [...new Set(ordered.flatMap((p) => p.trades))],
      doesNotDo: [...new Set(ordered.flatMap((p) => p.doesNotDo))],
      phones: [...new Set(items.flatMap((p) => [...p.phones]))].sort(),
      providerKeys,
      links: members.flatMap((i) => {
        const item = prepared[i]
        if (item === undefined) return []
        const joined = joinedBy.get(i) ?? { method: 'single_source' as const, evidence: {} }
        return [
          {
            ref: item.input.ref,
            providerKey: item.input.providerKey,
            method: joined.method,
            confidence: confidenceOf(joined.method),
            evidence: joined.evidence,
          },
        ]
      }),
    }
  })

  const providerIdByKey = new Map(
    providers.flatMap((provider) =>
      provider.providerKeys.map((key) => [key, provider.id] as const),
    ),
  )
  return { providers, providerIdByKey, decisions }
}
