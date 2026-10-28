import { DateTime } from 'luxon'
import {
  hasRole,
  type CalendarBlockCandidate,
  type Instant,
  type JobCandidate,
  type JobKind,
  type JobStatus,
  type PropertyKey,
  type ProviderKey,
  type SourceRef,
  type TimeBasis,
} from '../adapters/types.ts'
import { compareText, refKey, stableId } from './ids.ts'

/** CRM B jobs carry the native ID of the estimate they came from (original_estimate_id). */
export type JobInput = JobCandidate & { originalEstimateRecordId?: string | null }

export type JobMatchMethod =
  'single_source' | 'duplicate_row' | 'cross_source_time' | 'estimate_to_job' | 'calendar_mirror'

/** R8 (c), D-047. */
export const JOB_CONFIDENCE: Readonly<Record<JobMatchMethod, number>> = {
  single_source: 1,
  duplicate_row: 0.95,
  cross_source_time: 0.8,
  estimate_to_job: 1,
  calendar_mirror: 0.8,
}

/** Inclusive (D-021). */
export const CROSS_SOURCE_TOLERANCE_MINUTES = 30

/** A calendar mirror whose text disagrees with the job's is still one booking, but less sure. */
export const MIRROR_TEXT_MISMATCH_CONFIDENCE = 0.6

const TIME_ZONE = 'America/Chicago'

export interface JobLink {
  ref: SourceRef
  method: JobMatchMethod
  confidence: number
  /** Cross-source and mirror links include minutesApart. */
  evidence: Record<string, unknown>
}

export interface ResolvedJob {
  id: string
  providerId: string
  propertyId: string | null
  /** CRM A visits → the id of their parent job. */
  parentJobId: string | null
  kind: JobKind
  status: JobStatus
  startAt: Instant | null
  endAt: Instant | null
  allDay: boolean
  timeBasis: TimeBasis | null
  tradeRaw: string | null
  amountCents: number | null
  /** Source job rows collapsed into this job (1 when none); estimates and blocks not counted. */
  duplicateCount: number
  /** The lowest link confidence. */
  confidence: number
  /** One per source record, calendar blocks included. */
  links: JobLink[]
}

export interface JobResolutionInput {
  jobs: readonly JobInput[]
  calendarBlocks: readonly CalendarBlockCandidate[]
  providerIdByKey: ReadonlyMap<ProviderKey, string>
  propertyIdByKey: ReadonlyMap<PropertyKey, string>
  /**
   * G18, D-122: whether two different property ids are one home for mirroring (for example, one
   * side has no zip). Default: only equal ids are.
   */
  sameHome?: (blockPropertyId: string, jobPropertyId: string) => boolean
}

export interface JobResolution {
  jobs: ResolvedJob[]
  /** Calendar blocks that mirror a job; the block stays a calendar block, linked to the job. */
  mirroredBlocks: Array<{ blockRef: SourceRef; jobId: string; confidence: number }>
}

/** A job being built: its primary record, the times it carries, and its links. */
interface Group {
  primary: JobInput
  providerId: string
  propertyId: string | null
  account: string
  startAt: Instant | null
  endAt: Instant | null
  allDay: boolean
  timeBasis: TimeBasis | null
  rows: number
  links: JobLink[]
}

function accountOf(ref: SourceRef): string {
  return `${ref.sourceSystem}:${ref.sourceAccount}`
}

function minutesBetween(a: Instant, b: Instant): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 60_000
}

function localDate(instant: Instant): string | null {
  return DateTime.fromISO(instant, { zone: 'utc' }).setZone(TIME_ZONE).toISODate()
}

/** Lower case, punctuation and repeated spaces removed. */
function normalizeText(text: string | null): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Unknown text never disagrees; otherwise equal, contained, or sharing a word agrees. */
function textsAgree(a: string | null, b: string | null): boolean {
  const left = normalizeText(a)
  const right = normalizeText(b)
  if (left === '' || right === '') return true
  if (left.includes(right) || right.includes(left)) return true
  const words = new Set(left.split(' ').filter((word) => word.length > 2))
  return right.split(' ').some((word) => words.has(word))
}

function isDateOnly(job: { timeBasis: TimeBasis | null }): boolean {
  return job.timeBasis === 'date_only'
}

/** Joins `from` into `into` with method M: links still single_source take M, as with providers. */
function absorb(
  into: Group,
  from: Group,
  method: JobMatchMethod,
  evidence: Record<string, unknown>,
): void {
  const relabel = (link: JobLink): JobLink =>
    link.method === 'single_source'
      ? { ...link, method, confidence: JOB_CONFIDENCE[method], evidence }
      : link
  into.links = [...into.links.map(relabel), ...from.links.map(relabel)]
  into.rows += from.rows
}

function singleGroup(job: JobInput, input: JobResolutionInput): Group {
  const propertyId =
    job.propertyKey === null ? null : (input.propertyIdByKey.get(job.propertyKey) ?? null)
  return {
    primary: job,
    providerId: input.providerIdByKey.get(job.providerKey) ?? job.providerKey,
    propertyId,
    account: accountOf(job.ref),
    startAt: job.startAt,
    endAt: job.endAt,
    allDay: job.allDay,
    timeBasis: job.timeBasis,
    rows: 1,
    links: [{ ref: job.ref, method: 'single_source', confidence: 1, evidence: {} }],
  }
}

/** D-017, G5: an estimate named by a job of the same account folds into that job. */
function foldEstimates(groups: Group[]): Group[] {
  const estimates = new Map(
    groups
      .filter((group) => group.primary.kind === 'estimate')
      .map((group) => [`${group.account}:${group.primary.ref.sourceRecordId}`, group]),
  )
  const folded = new Set<Group>()
  groups.forEach((group) => {
    const estimateId = group.primary.originalEstimateRecordId
    if (group.primary.kind === 'estimate' || estimateId === undefined || estimateId === null) return
    const estimate = estimates.get(`${group.account}:${estimateId}`)
    if (estimate === undefined || folded.has(estimate)) return
    folded.add(estimate)
    group.links = [
      ...group.links,
      ...estimate.links.map((link) => ({
        ...link,
        method: 'estimate_to_job' as const,
        confidence: JOB_CONFIDENCE.estimate_to_job,
        evidence: { originalEstimateRecordId: estimateId },
      })),
    ]
  })
  return groups.filter((group) => !folded.has(group))
}

/**
 * G16, D-084: rows of a hand-kept log (the CSV) identical after normalization collapse into one
 * job. Status and notes are part of the signature, so a cancelled copy of a booked row stays its
 * own job.
 */
function collapseDuplicateRows(groups: Group[]): Group[] {
  const bySignature = new Map<string, Group>()
  return groups.filter((group) => {
    const job = group.primary
    if (!hasRole(job.ref.sourceSystem, 'log')) return true
    const signature = JSON.stringify([
      group.account,
      group.providerId,
      job.startAt,
      job.timeBasis,
      group.propertyId ?? job.propertyKey,
      normalizeText(job.tradeRaw),
      job.amountCents,
      job.status,
      normalizeText(job.notesRaw),
    ])
    const first = bySignature.get(signature)
    if (first === undefined) {
      bySignature.set(signature, group)
      return true
    }
    absorb(first, group, 'duplicate_row', { duplicateOf: refKey(first.primary.ref) })
    return false
  })
}

/**
 * Jobs from different source accounts with the same canonical provider and property starting
 * within the tolerance are one job (D-021). Records of one account never merge by time.
 */
function mergeCrossSource(groups: Group[]): Group[] {
  const merged = new Set<Group>()
  const accounts = new Map(groups.map((group) => [group, new Set([group.account])]))
  groups.forEach((group, i) => {
    if (merged.has(group)) return
    groups.slice(i + 1).forEach((other) => {
      if (merged.has(other)) return
      const mine = accounts.get(group) ?? new Set<string>()
      const theirs = accounts.get(other) ?? new Set<string>()
      if (
        group.startAt === null ||
        other.startAt === null ||
        isDateOnly(group) ||
        isDateOnly(other) ||
        group.propertyId === null ||
        group.propertyId !== other.propertyId ||
        group.providerId !== other.providerId ||
        [...theirs].some((account) => mine.has(account))
      ) {
        return
      }
      const minutesApart = minutesBetween(group.startAt, other.startAt)
      if (minutesApart > CROSS_SOURCE_TOLERANCE_MINUTES) return
      absorb(group, other, 'cross_source_time', { minutesApart })
      theirs.forEach((account) => mine.add(account))
      merged.add(other)
    })
  })
  return groups.filter((group) => !merged.has(group))
}

function isMirrorable(block: CalendarBlockCandidate): boolean {
  return block.busy && block.category === 'work' && !block.allDay
}

/**
 * G17, G18, D-021: a busy work block of the same provider within the tolerance mirrors a job
 * (no property needed). A date-only row takes the time of the provider's single work block that
 * local day. The block stays a calendar block; it is linked to the job and listed as mirrored.
 * G18, D-085: when the block's property and the job's are both known and differ, they are two
 * bookings, never a mirror; D-122: a missing zip on one side is not a difference (sameHome).
 */
function mirrorCalendarBlocks(
  groups: Group[],
  blocks: readonly CalendarBlockCandidate[],
  input: JobResolutionInput,
  jobIdOf: (group: Group) => string,
): JobResolution['mirroredBlocks'] {
  const mirrored: JobResolution['mirroredBlocks'] = []
  const usedGroups = new Set<Group>()
  const candidates = [...blocks]
    .filter(isMirrorable)
    .sort((a, b) => compareText(a.startAt, b.startAt) || compareText(refKey(a.ref), refKey(b.ref)))
  const providerOf = (block: CalendarBlockCandidate) =>
    input.providerIdByKey.get(block.providerKey) ?? block.providerKey
  const propertyOf = (block: CalendarBlockCandidate) =>
    block.propertyKey === undefined || block.propertyKey === null
      ? null
      : (input.propertyIdByKey.get(block.propertyKey) ?? null)
  /** true: same known property; false: different known properties; null: either is unknown. */
  const sameProperty = (group: Group, block: CalendarBlockCandidate) => {
    const blockProperty = propertyOf(block)
    if (group.propertyId === null || blockProperty === null) return null
    return (
      group.propertyId === blockProperty ||
      (input.sameHome?.(blockProperty, group.propertyId) ?? false)
    )
  }

  function link(group: Group, block: CalendarBlockCandidate, evidence: Record<string, unknown>) {
    const agrees = textsAgree(group.primary.tradeRaw, block.summaryRaw)
    const addressEvidence = sameProperty(group, block) === true ? { addressAgrees: true } : {}
    const confidence = agrees ? JOB_CONFIDENCE.calendar_mirror : MIRROR_TEXT_MISMATCH_CONFIDENCE
    group.links = [
      ...group.links,
      {
        ref: block.ref,
        method: 'calendar_mirror',
        confidence,
        evidence: { ...evidence, textAgrees: agrees, ...addressEvidence },
      },
    ]
    usedGroups.add(group)
    mirrored.push({ blockRef: block.ref, jobId: jobIdOf(group), confidence })
  }

  const timedLeft = candidates.filter((block) => {
    const providerId = providerOf(block)
    const nearest = groups
      .filter(
        (group) =>
          !usedGroups.has(group) &&
          group.providerId === providerId &&
          group.startAt !== null &&
          !isDateOnly(group) &&
          group.primary.status !== 'cancelled' &&
          sameProperty(group, block) !== false,
      )
      .map((group) => ({ group, minutesApart: minutesBetween(group.startAt ?? '', block.startAt) }))
      .filter((entry) => entry.minutesApart <= CROSS_SOURCE_TOLERANCE_MINUTES)
      .sort((a, b) => a.minutesApart - b.minutesApart)[0]
    if (nearest === undefined) return true
    link(nearest.group, block, { minutesApart: nearest.minutesApart })
    return false
  })

  groups
    .filter((group) => isDateOnly(group) && group.startAt !== null && !usedGroups.has(group))
    .forEach((group) => {
      const day = localDate(group.startAt ?? '')
      const sameDay = candidates.filter(
        (block) =>
          providerOf(block) === group.providerId &&
          localDate(block.startAt) === day &&
          sameProperty(group, block) !== false,
      )
      const [only] = sameDay
      if (only === undefined || sameDay.length > 1 || !timedLeft.includes(only)) return
      group.startAt = only.startAt
      group.endAt = only.endAt
      group.allDay = false
      group.timeBasis = only.timeBasis
      link(group, only, { sameLocalDate: day })
    })

  return mirrored
}

/**
 * Builds canonical jobs from job candidates and calendar blocks (R8, D-017, D-021, D-047):
 * estimates fold into the job that names them, duplicate CSV rows collapse, cross-source CRM
 * copies merge, calendar blocks that mirror a job are linked to it, and visits point at their
 * parent job.
 */
export function resolveJobs(input: JobResolutionInput): JobResolution {
  const sorted = [...input.jobs].sort((a, b) => compareText(refKey(a.ref), refKey(b.ref)))
  const groups = mergeCrossSource(
    collapseDuplicateRows(foldEstimates(sorted.map((job) => singleGroup(job, input)))),
  )
  const jobIdOf = (group: Group) => stableId('job', refKey(group.primary.ref))
  const mirroredBlocks = mirrorCalendarBlocks(groups, input.calendarBlocks, input, jobIdOf)

  const idByRecord = new Map(
    groups.map((group) => [`${group.account}:${group.primary.ref.sourceRecordId}`, jobIdOf(group)]),
  )
  const jobs = groups.map((group): ResolvedJob => {
    const job = group.primary
    const parentJobId =
      job.parentSourceRecordId === null
        ? null
        : (idByRecord.get(`${group.account}:${job.parentSourceRecordId}`) ?? null)
    return {
      id: jobIdOf(group),
      providerId: group.providerId,
      propertyId: group.propertyId,
      parentJobId,
      kind: job.kind,
      status: job.status,
      startAt: group.startAt,
      endAt: group.endAt,
      allDay: group.allDay,
      timeBasis: group.timeBasis,
      tradeRaw: job.tradeRaw,
      amountCents: job.amountCents,
      duplicateCount: group.rows,
      confidence: Math.min(...group.links.map((link) => link.confidence)),
      links: group.links,
    }
  })
  return { jobs, mirroredBlocks }
}
