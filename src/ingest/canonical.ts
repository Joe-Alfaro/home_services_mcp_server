import { createHash } from 'node:crypto'
import { DateTime } from 'luxon'
import type {
  CalendarBlockCandidate,
  Candidate,
  CandidateBatch,
  DeclaredHoursCandidate,
  JobCandidate,
  ProviderCandidate,
  SourceRef,
  SourceSystem,
} from '../adapters/types.ts'
import { addressKey, normalizeAddress, type NormalizedAddress } from '../normalize/address.ts'
import type { StreetIndex } from '../normalize/geocode.ts'
import { normalizePhone } from '../normalize/phone.ts'
import { redactText } from '../normalize/redact.ts'
import { classifyJob, type TradeConflict } from '../normalize/trade.ts'
import { refKey, stableId } from '../resolve/ids.ts'
import { resolveJobs } from '../resolve/jobs.ts'
import { resolveProperties, type ResolvedProperty } from '../resolve/properties.ts'
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
  kind: 'hours' | 'service_area' | 'trade' | 'crm'
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
  /** G9: the local date "YYYY-MM-DD" the job moved from; its old slot never blocks. */
  rescheduledFrom: string | null
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
  /** G20: the profile claims 24/7; openings then come from observed hours. */
  alwaysOpen: boolean
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
  /** G17: a tentative hold still blocks, at low confidence. */
  status: NonNullable<CalendarBlockCandidate['status']>
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
/**
 * R8 (c): a job record belongs to its account by construction, so the account_record tier is
 * certain on its own; its link carries this times the account's own match confidence.
 */
export const ACCOUNT_RECORD_CONFIDENCE = 1

const TIME_ZONE = 'America/Chicago'

/** Booked work: what a provider was actually there for (cancelled and undated work never is). */
const BOOKED_STATUSES: ReadonlySet<JobRow['status']> = new Set([
  'completed',
  'scheduled',
  'in_progress',
])

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

function minutesOf(time: string): number {
  const [hours = 0, minutes = 0] = time.split(':').map(Number)
  return hours * 60 + minutes
}

/**
 * True when the booking's local span fits inside one declared window of its local weekday. A
 * booking without an end is judged by its start alone.
 */
function withinDeclaredHours(job: JobRow, hours: DeclaredHoursCandidate): boolean {
  const start = DateTime.fromISO(job.startAt ?? '', { zone: 'utc' }).setZone(TIME_ZONE)
  const startMinutes = start.hour * 60 + start.minute
  const lengthMinutes =
    job.endAt === null ? 0 : (Date.parse(job.endAt) - Date.parse(job.startAt ?? '')) / 60_000
  const endMinutes = startMinutes + Math.max(lengthMinutes, 0)
  return hours.weekly.some(
    (window) =>
      window.weekday === start.weekday &&
      minutesOf(window.start) <= startMinutes &&
      endMinutes <= minutesOf(window.end),
  )
}

/**
 * G23, R13 f, D-110: one hours conflict per provider whose timed bookings (completed, scheduled
 * or in progress) fall outside fully parsed declared hours. 24/7 claims are not a pattern (G20).
 */
function hoursConflict(
  providerId: string,
  hours: DeclaredHoursCandidate | undefined,
  providerJobs: readonly JobRow[],
  recordsOf: (job: JobRow) => RecordKey[],
): ProviderConflictRow[] {
  if (hours === undefined || hours.parsed !== 'full' || hours.alwaysOpen === true) return []
  const outside = providerJobs
    .filter(
      (job) =>
        BOOKED_STATUSES.has(job.status) &&
        job.startAt !== null &&
        !job.allDay &&
        job.timeBasis !== 'date_only' &&
        !withinDeclaredHours(job, hours),
    )
    .sort((a, b) => (a.startAt ?? '').localeCompare(b.startAt ?? '') || a.id.localeCompare(b.id))
  if (outside.length === 0) return []
  const localDates = unique(
    outside.map((job) =>
      DateTime.fromISO(job.startAt ?? '', { zone: 'utc' })
        .setZone(TIME_ZONE)
        .toISODate(),
    ),
  )
  return [
    {
      providerId,
      kind: 'hours',
      detail: {
        declaredHours: hours.hoursRaw,
        outsideBookings: outside.length,
        completed: outside.filter((job) => job.status === 'completed').length,
        scheduledOrInProgress: outside.filter((job) => job.status !== 'completed').length,
        localDates,
      },
      records: outside.flatMap(recordsOf),
    },
  ]
}

/** Home identity without the zip: number + street + type + unit. */
function zipFreeIdentity(address: NormalizedAddress): string {
  return addressKey({ ...address, zip: null })
}

/**
 * G18, D-085: each block's LOCATION normalized like a property address. A location that names a
 * known property maps to it; any other full address (house number and street) maps to a home of
 * its own, so the resolver refuses a mirror to a job at a different known home. Locations without
 * a full address stay unknown (time-only mirroring, D-021).
 * G18, D-122: `sameHome` tells the resolver that two homes with the same number, street and unit
 * are one address when only one side has a zip (a zip-less CSV row and a zipped CRM record or
 * LOCATION of the same house are often two property rows).
 */
function withBlockProperties(
  blocks: readonly CalendarBlockCandidate[],
  index: StreetIndex,
  propertyIdByKey: ReadonlyMap<string, string>,
  properties: readonly ResolvedProperty[],
): {
  blocks: CalendarBlockCandidate[]
  propertyIdByKey: Map<string, string>
  sameHome: (a: string, b: string) => boolean
} {
  const byKey = new Map(propertyIdByKey)
  const propertyIdByAddress = new Map(properties.map((p) => [p.addressKey, p.id]))
  const addressById = new Map(properties.map((p) => [p.id, p.address]))
  const located = blocks.map((block) => {
    if (block.location === undefined || block.location === null) return block
    const address = normalizeAddress(block.location, index)
    if (address.houseNumber === null || address.streetName === null) return block
    const propertyKey = `${block.providerKey}:location:${address.key}`
    const propertyId = propertyIdByAddress.get(address.key) ?? `location:${address.key}`
    byKey.set(propertyKey, propertyId)
    if (!addressById.has(propertyId)) addressById.set(propertyId, address)
    return { ...block, propertyKey }
  })
  function sameHome(a: string, b: string): boolean {
    const left = addressById.get(a)
    const right = addressById.get(b)
    if (left === undefined || right === undefined) return false
    if (left.houseNumber === null || left.streetName === null) return false
    if ((left.zip === null) === (right.zip === null)) return false
    return zipFreeIdentity(left) === zipFreeIdentity(right)
  }
  return { blocks: located, propertyIdByKey: byKey, sameHome }
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
  const located = withBlockProperties(
    blockCandidates,
    index,
    propertyResolution.propertyIdByKey,
    propertyResolution.properties,
  )
  const jobResolution = resolveJobs({
    jobs: jobCandidates,
    calendarBlocks: located.blocks,
    providerIdByKey: providerResolution.providerIdByKey,
    propertyIdByKey: located.propertyIdByKey,
    sameHome: located.sameHome,
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
      rescheduledFrom: primary?.rescheduledFrom ?? null,
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

  // G6: a CRM A job with visits is a container; its visits are the work, so it is not counted.
  const visitParents = new Set(
    jobs.flatMap((job) => (job.parentJobId === null ? [] : [job.parentJobId])),
  )
  const work = jobs.filter((job) => !visitParents.has(job.id))

  // Completed jobs and visits are where a provider has actually worked (G23).
  const worked = work.filter(
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
      work.filter((job) => job.tradeConflict !== null),
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

  const jobsByProvider = groupBy(work, (job) => job.providerId)
  const hoursConflicts = providers.flatMap((provider) =>
    hoursConflict(
      provider.id,
      hoursByProvider.get(provider.id),
      jobsByProvider.get(provider.id) ?? [],
      primaryRecord,
    ),
  )

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
        confidence: accountLink.confidence * ACCOUNT_RECORD_CONFIDENCE,
        evidence: {
          providerKey: job.providerKey,
          accountMethod: accountLink.method,
          accountConfidence: accountLink.confidence,
        },
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
      alwaysOpen: hours.alwaysOpen ?? false,
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
        status: block.status ?? 'confirmed',
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
    providerConflicts: [
      ...hoursConflicts,
      ...serviceAreaConflicts,
      ...tradeConflicts,
      ...crmConflicts,
    ],
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
