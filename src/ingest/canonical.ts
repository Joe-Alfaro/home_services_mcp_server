import { createHash } from 'node:crypto'
import type {
  Candidate,
  CandidateBatch,
  DeclaredHoursCandidate,
  JobCandidate,
  ProviderCandidate,
  SourceRef,
  SourceSystem,
} from '../adapters/types.ts'
import type { StreetIndex } from '../normalize/geocode.ts'
import { normalizePhone } from '../normalize/phone.ts'
import { redactText } from '../normalize/redact.ts'
import { classifyJob, type TradeConflict } from '../normalize/trade.ts'
import { refKey, stableId } from '../resolve/ids.ts'
import { resolveJobs } from '../resolve/jobs.ts'
import { resolveProperties } from '../resolve/properties.ts'
import { resolveProviders, type ResolvedProvider } from '../resolve/providers.ts'

/*
 * Pure: candidate batches → canonical rows (ARCHITECTURE.md "Canonical Postgres schema"). Rows
 * point at source records by `RecordKey`; src/db/canonical.ts swaps those for source_records ids.
 */

/** "<sourceSystem>|<sourceFile>|<sourceRecordId>|<recordType>": one source_records row. */
export type RecordKey = string

export function recordKeyOf(ref: SourceRef, recordType: Candidate['type']): RecordKey {
  return [ref.sourceSystem, ref.sourceFile, ref.sourceRecordId, recordType].join('|')
}

export interface LinkRow {
  entityId: string
  record: RecordKey
  method: string
  confidence: number
  evidence: Record<string, unknown>
}

export interface ProviderRow {
  id: string
  displayName: string
  aliases: string[]
  trades: string[]
  doesNotDo: string[]
  declaredServiceZips: string[] | null
  observedServiceZips: string[]
  crewSize: number | null
  businessPhone: string | null
  website: string | null
  declaredCrm: string | null
  hoursRaw: string | null
  hoursParsed: DeclaredHoursCandidate['parsed'] | null
  confidence: number
}

export interface ProviderConflictRow {
  providerId: string
  kind: 'service_area' | 'trade' | 'crm'
  detail: Record<string, unknown>
  records: RecordKey[]
}

export interface PropertyRow {
  id: string
  addressKey: string
  houseNumber: string | null
  streetName: string | null
  streetType: string | null
  unit: string | null
  zip: string | null
  zipInferred: boolean
  city: string | null
  blockNumber: number | null
  blockLabel: string | null
  lat: number | null
  lon: number | null
  geocodeMethod: 'interpolated' | 'none'
  geocodeReason: string | null
  inTargetZip: boolean
  confidence: number
}

export interface PropertyLinkRow extends LinkRow {
  rawAddressHash: string
}

export interface ContactRow {
  propertyId: string
  record: RecordKey
  name: string | null
  phones: string[]
  emails: string[]
}

export interface JobRow {
  id: string
  providerId: string
  propertyId: string | null
  parentJobId: string | null
  kind: JobCandidate['kind']
  status: JobCandidate['status']
  statusRaw: string
  trade: string | null
  service: string | null
  tradeMethod: string
  tradeConflict: TradeConflict | null
  startAt: string | null
  endAt: string | null
  allDay: boolean
  timeBasis: string | null
  completedAt: string | null
  amountCents: number | null
  isRecurring: boolean
  descriptionRedacted: string | null
  rescheduleNoteRedacted: string | null
  duplicateCount: number
  confidence: number
}

export interface DeclaredHoursRow {
  providerId: string
  weekday: number
  startLocal: string
  endLocal: string
  record: RecordKey
  parsed: DeclaredHoursCandidate['parsed']
}

export interface CalendarBlockRow {
  id: string
  providerId: string
  startAt: string
  endAt: string
  allDay: boolean
  timeBasis: string
  busy: boolean
  category: 'work' | 'personal' | 'unknown'
  recurrenceUid: string | null
  mirroredJobId: string | null
  mirrorConfidence: number | null
  record: RecordKey
}

export interface MatchDecisionRow {
  entity: 'provider' | 'property' | 'job'
  leftRef: string
  rightRef: string
  method: string
  score: number
  decision: 'accepted' | 'rejected'
  evidence: Record<string, unknown>
}

export interface CanonicalModel {
  providers: ProviderRow[]
  providerLinks: LinkRow[]
  providerConflicts: ProviderConflictRow[]
  properties: PropertyRow[]
  propertyLinks: PropertyLinkRow[]
  contacts: ContactRow[]
  jobs: JobRow[]
  jobLinks: LinkRow[]
  declaredHours: DeclaredHoursRow[]
  calendarBlocks: CalendarBlockRow[]
  matchDecisions: MatchDecisionRow[]
}

/** provider_links method for a job record tied to its provider through its account. */
export const ACCOUNT_RECORD_METHOD = 'account_record'

const CRM_SYSTEMS: ReadonlyArray<[SourceSystem, RegExp]> = [
  ['jobber', /jobber/i],
  ['housecall_pro', /housecall|\bhcp\b/i],
  ['workiz', /workiz/i],
]

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)]
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  items.forEach((item) => {
    const key = keyOf(item)
    groups.set(key, [...(groups.get(key) ?? []), item])
  })
  return groups
}

function minConfidence(confidences: readonly number[]): number {
  return confidences.length === 0 ? 1 : Math.min(...confidences)
}

/** Provider-level facts the resolver does not carry: profile fields, names, hours. */
function providerRow(
  provider: ResolvedProvider,
  candidates: readonly ProviderCandidate[],
  hours: DeclaredHoursCandidate | undefined,
  observedZips: readonly string[],
): ProviderRow {
  const profile = candidates.find((candidate) => candidate.ref.sourceSystem === 'profiles')
  // A calendar is named after its owner (G27), so its name is never shown as a business name.
  const named = candidates.filter((candidate) => candidate.ref.sourceSystem !== 'ics')
  const aliases = unique([
    ...(profile === undefined ? [] : [profile.businessName]),
    ...named.map((candidate) => candidate.businessName),
  ])
  const fallbackName = candidates[0]?.ref.sourceAccount ?? provider.id
  const profilePhone = profile?.phones
    .map((phone) => normalizePhone(phone))
    .find((phone) => phone !== null)
  return {
    id: provider.id,
    displayName: aliases[0] ?? fallbackName,
    aliases,
    trades: provider.trades,
    doesNotDo: provider.doesNotDo,
    declaredServiceZips: profile?.declaredServiceZips ?? null,
    observedServiceZips: [...observedZips].sort(),
    crewSize: profile?.crewSize ?? null,
    businessPhone: profilePhone ?? provider.phones[0] ?? null,
    website: profile?.website ?? candidates.find((c) => c.website !== null)?.website ?? null,
    declaredCrm: profile?.declaredCrm ?? null,
    hoursRaw: hours?.hoursRaw ?? null,
    hoursParsed: hours?.parsed ?? null,
    confidence: minConfidence(provider.links.map((link) => link.confidence)),
  }
}

/** A profile's CRM against the CRMs the provider's records actually come from. */
function crmConflict(
  providerId: string,
  candidates: readonly ProviderCandidate[],
): ProviderConflictRow[] {
  const profile = candidates.find((candidate) => candidate.ref.sourceSystem === 'profiles')
  if (profile?.declaredCrm == null) return []
  const declaredCrm = profile.declaredCrm
  const declared = CRM_SYSTEMS.filter(([, pattern]) => pattern.test(declaredCrm)).map(
    ([system]) => system,
  )
  const crmCandidates = candidates.filter((candidate) =>
    CRM_SYSTEMS.some(([system]) => system === candidate.ref.sourceSystem),
  )
  const observed = unique(crmCandidates.map((candidate) => candidate.ref.sourceSystem)).sort()
  const undeclared = observed.filter((system) => !declared.includes(system))
  if (undeclared.length === 0) return []
  return [
    {
      providerId,
      kind: 'crm',
      detail: { declared: declaredCrm, declaredSystems: declared, observedSystems: observed },
      records: [
        recordKeyOf(profile.ref, 'provider'),
        ...crmCandidates
          .filter((candidate) => undeclared.includes(candidate.ref.sourceSystem))
          .map((candidate) => recordKeyOf(candidate.ref, 'provider')),
      ],
    },
  ]
}

export function buildCanonical(
  batches: readonly CandidateBatch[],
  index: StreetIndex,
): CanonicalModel {
  const providerCandidates = batches.flatMap((batch) => batch.providers)
  const propertyCandidates = batches.flatMap((batch) => batch.properties)
  const jobCandidates = batches.flatMap((batch) => batch.jobs)
  const blockCandidates = batches.flatMap((batch) => batch.calendarBlocks)
  const hoursCandidates = batches.flatMap((batch) => batch.declaredHours)

  const providerResolution = resolveProviders(providerCandidates)
  const propertyResolution = resolveProperties(propertyCandidates, index)
  const jobResolution = resolveJobs({
    jobs: jobCandidates,
    calendarBlocks: blockCandidates,
    providerIdByKey: providerResolution.providerIdByKey,
    propertyIdByKey: propertyResolution.propertyIdByKey,
  })
  const { providerIdByKey } = providerResolution

  const providerById = new Map(providerResolution.providers.map((p) => [p.id, p]))
  const propertyById = new Map(propertyResolution.properties.map((p) => [p.id, p]))
  const jobRecordKeys = new Set(jobCandidates.map((job) => recordKeyOf(job.ref, 'job')))
  const primaryJobById = new Map(
    jobCandidates.map((job) => [stableId('job', refKey(job.ref)), job]),
  )
  const propertyCandidateByRecord = new Map(
    propertyCandidates.map((candidate) => [recordKeyOf(candidate.ref, 'property'), candidate]),
  )
  const contactNamesByProperty = groupBy(propertyResolution.contacts, (c) => c.propertyId)

  // Jobs first: observed zips and trade conflicts feed the provider rows.
  const jobs = jobResolution.jobs.map((job): JobRow => {
    const primary = primaryJobById.get(job.id)
    const provider = providerById.get(job.providerId)
    const text = primary?.tradeRaw ?? primary?.descriptionRaw ?? null
    const classification = classifyJob({
      text,
      providerTrades: provider?.trades ?? [],
      providerDoesNotDo: provider?.doesNotDo ?? [],
    })
    const names = (
      job.propertyId === null ? [] : (contactNamesByProperty.get(job.propertyId) ?? [])
    )
      .map((entry) => entry.contact.name)
      .filter((name): name is string => name !== null)
    return {
      id: job.id,
      providerId: job.providerId,
      propertyId: job.propertyId,
      parentJobId: job.parentJobId,
      kind: job.kind,
      status: job.status,
      statusRaw: primary?.statusRaw ?? '',
      trade: classification.trade,
      service: classification.service,
      tradeMethod: classification.method,
      tradeConflict: classification.conflict,
      startAt: job.startAt,
      endAt: job.endAt,
      allDay: job.allDay,
      timeBasis: job.timeBasis,
      completedAt: primary?.completedAt ?? null,
      amountCents: job.amountCents,
      isRecurring: primary?.isRecurring ?? false,
      descriptionRedacted: redactText(text, { names }),
      rescheduleNoteRedacted: redactText(primary?.rescheduleNote ?? null, { names }),
      duplicateCount: job.duplicateCount,
      confidence: job.confidence,
    }
  })
  const jobLinks = jobResolution.jobs.flatMap((job) =>
    job.links.map((link): LinkRow => {
      const asJob = recordKeyOf(link.ref, 'job')
      return {
        entityId: job.id,
        record: jobRecordKeys.has(asJob) ? asJob : recordKeyOf(link.ref, 'calendar_block'),
        method: link.method,
        confidence: link.confidence,
        evidence: link.evidence,
      }
    }),
  )

  // Completed jobs and visits are where a provider has actually worked (G23).
  const worked = jobs.filter(
    (job) => job.status === 'completed' && job.kind !== 'estimate' && job.propertyId !== null,
  )
  const workedZips = (job: JobRow) => propertyById.get(job.propertyId ?? '')?.address.zip ?? null
  const workedByProvider = groupBy(worked, (job) => job.providerId)

  const candidatesByProvider = groupBy(
    providerCandidates,
    (candidate) => providerIdByKey.get(candidate.providerKey) ?? '',
  )
  const hoursByProvider = new Map(
    hoursCandidates.map((hours) => [providerIdByKey.get(hours.providerKey) ?? '', hours]),
  )

  const providers = providerResolution.providers.map((provider) =>
    providerRow(
      provider,
      candidatesByProvider.get(provider.id) ?? [],
      hoursByProvider.get(provider.id),
      unique(
        (workedByProvider.get(provider.id) ?? [])
          .map(workedZips)
          .filter((zip): zip is string => zip !== null),
      ),
    ),
  )

  const primaryRecord = (job: JobRow) => {
    const primary = primaryJobById.get(job.id)
    return primary === undefined ? [] : [recordKeyOf(primary.ref, 'job')]
  }

  const serviceAreaConflicts = providers.flatMap((provider): ProviderConflictRow[] => {
    const declared = provider.declaredServiceZips
    if (declared === null) return []
    const outside = groupBy(
      (workedByProvider.get(provider.id) ?? []).filter((job) => {
        const zip = workedZips(job)
        return zip !== null && !declared.includes(zip)
      }),
      (job) => workedZips(job) ?? '',
    )
    return [...outside.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([zip, zipJobs]) => ({
        providerId: provider.id,
        kind: 'service_area',
        detail: { zip, completedJobs: zipJobs.length, declaredZips: declared },
        records: zipJobs.flatMap(primaryRecord),
      }))
  })

  const tradeConflicts = [
    ...groupBy(
      jobs.filter((job) => job.tradeConflict !== null),
      (job) =>
        [job.providerId, job.tradeConflict?.observedTrade, job.tradeConflict?.reason].join('|'),
    ).values(),
  ].map((conflictJobs): ProviderConflictRow => {
    const [first] = conflictJobs
    return {
      providerId: first?.providerId ?? '',
      kind: 'trade',
      detail: {
        observedTrade: first?.tradeConflict?.observedTrade,
        reason: first?.tradeConflict?.reason,
        jobs: conflictJobs.length,
      },
      records: conflictJobs.flatMap(primaryRecord),
    }
  })

  const crmConflicts = providers.flatMap((provider) =>
    crmConflict(provider.id, candidatesByProvider.get(provider.id) ?? []),
  )

  const accountLinks = providerResolution.providers.flatMap((provider) =>
    provider.links.map((link): LinkRow => ({
      entityId: provider.id,
      record: recordKeyOf(link.ref, 'provider'),
      method: link.method,
      confidence: link.confidence,
      evidence: link.evidence,
    })),
  )
  // Every job record also traces to its provider, so a provider is reachable from any file of
  // its account (a CRM C jobs file holds no account record). The job belongs to the account by
  // construction; the account's own link carries the match confidence.
  const accountLinkByKey = new Map(
    providerResolution.providers.flatMap((provider) =>
      provider.links.map((link) => [link.providerKey, link] as const),
    ),
  )
  const jobRecordLinks = jobCandidates.flatMap((job): LinkRow[] => {
    const providerId = providerIdByKey.get(job.providerKey)
    const accountLink = accountLinkByKey.get(job.providerKey)
    if (providerId === undefined || accountLink === undefined) return []
    return [
      {
        entityId: providerId,
        record: recordKeyOf(job.ref, 'job'),
        method: ACCOUNT_RECORD_METHOD,
        confidence: accountLink.confidence,
        evidence: { providerKey: job.providerKey, accountMethod: accountLink.method },
      },
    ]
  })
  const providerLinks = [...accountLinks, ...jobRecordLinks]

  const properties = propertyResolution.properties.map((property): PropertyRow => {
    const { address, geocode } = property
    const keyless = address.houseNumber === null || address.streetName === null
    return {
      id: property.id,
      // Keyless addresses stay separate homes (D-065), so their key gets the id to stay unique.
      addressKey: keyless ? `${property.addressKey}#${property.id}` : property.addressKey,
      houseNumber: address.houseNumber,
      streetName: address.streetName,
      streetType: address.streetType,
      unit: address.unit,
      zip: address.zip,
      zipInferred: address.zipInferred,
      city: address.city,
      blockNumber: address.blockNumber,
      blockLabel: address.blockLabel,
      lat: geocode.lat,
      lon: geocode.lon,
      geocodeMethod: geocode.geocodeMethod,
      geocodeReason: geocode.reason,
      inTargetZip: geocode.inTargetZip,
      confidence: minConfidence(property.links.map((link) => link.confidence)),
    }
  })
  const propertyLinks = propertyResolution.properties.flatMap((property) =>
    property.links.map((link): PropertyLinkRow => {
      const record = recordKeyOf(link.ref, 'property')
      const raw = propertyCandidateByRecord.get(record)?.address ?? null
      return {
        entityId: property.id,
        record,
        rawAddressHash: sha256(JSON.stringify(raw)),
        method: link.method,
        confidence: link.confidence,
        evidence: link.evidence,
      }
    }),
  )
  const contacts = propertyResolution.contacts.map((entry): ContactRow => ({
    propertyId: entry.propertyId,
    record: recordKeyOf(entry.ref, 'property'),
    name: entry.contact.name,
    phones: entry.contact.phones,
    emails: entry.contact.emails,
  }))

  const declaredHours = hoursCandidates.flatMap((hours) => {
    const providerId = providerIdByKey.get(hours.providerKey)
    if (providerId === undefined) return []
    return hours.weekly.map((window): DeclaredHoursRow => ({
      providerId,
      weekday: window.weekday,
      startLocal: window.start,
      endLocal: window.end,
      record: recordKeyOf(hours.ref, 'declared_hours'),
      parsed: hours.parsed,
    }))
  })

  const mirrorByBlock = new Map(
    jobResolution.mirroredBlocks.map((mirror) => [refKey(mirror.blockRef), mirror]),
  )
  const calendarBlocks = blockCandidates.flatMap((block): CalendarBlockRow[] => {
    const providerId = providerIdByKey.get(block.providerKey)
    if (providerId === undefined) return []
    const mirror = mirrorByBlock.get(refKey(block.ref))
    return [
      {
        id: stableId('blk', refKey(block.ref)),
        providerId,
        startAt: block.startAt,
        endAt: block.endAt,
        allDay: block.allDay,
        timeBasis: block.timeBasis,
        busy: block.busy,
        category: block.category,
        recurrenceUid: block.recurrence?.masterUid ?? null,
        mirroredJobId: mirror?.jobId ?? null,
        mirrorConfidence: mirror?.confidence ?? null,
        record: recordKeyOf(block.ref, 'calendar_block'),
      },
    ]
  })

  const matchDecisions = providerResolution.decisions.map((decision): MatchDecisionRow => ({
    entity: decision.entity,
    leftRef: refKey(decision.leftRef),
    rightRef: refKey(decision.rightRef),
    method: decision.method,
    score: decision.score,
    decision: decision.decision,
    evidence: decision.evidence,
  }))

  return {
    providers,
    providerLinks,
    providerConflicts: [...serviceAreaConflicts, ...tradeConflicts, ...crmConflicts],
    properties,
    propertyLinks,
    contacts,
    jobs,
    jobLinks,
    declaredHours,
    calendarBlocks,
    matchDecisions,
  }
}
