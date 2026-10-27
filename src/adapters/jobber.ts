import { dollarsToCents } from '../normalize/money.ts'
import { isoToInstant } from '../normalize/time.ts'
import {
  arrayAt,
  compact,
  emptyBatch,
  fileName,
  fileStem,
  finishJob,
  isObject,
  joinName,
  makeIssue,
  mapStatus,
  mergeBatches,
  objectAt,
  parseJsonFile,
  refFactory,
  rescheduleNoteOf,
  sortByPath,
  statusTable,
  textAt,
  type JsonObject,
} from './shared.ts'
import type {
  AdapterContext,
  CandidateBatch,
  IngestIssue,
  JobCandidate,
  PropertyCandidate,
  ProviderCandidate,
  SourceAdapter,
  SourceFile,
  SourceRef,
} from './types.ts'

// CRM A. Visits use visitStatus; jobs without visits use the job-level jobStatus.
const VISIT_STATUS = statusTable({
  COMPLETED: 'completed',
  UPCOMING: 'scheduled',
  TODAY: 'scheduled',
  CANCELLED: 'cancelled',
  OVERDUE: 'limbo',
  UNSCHEDULED: 'unscheduled',
})

const JOB_STATUS = statusTable({
  archived: 'completed',
  requires_invoicing: 'completed',
  upcoming: 'scheduled',
  today: 'scheduled',
  active: 'in_progress',
  action_required: 'on_hold',
  unscheduled: 'unscheduled',
})

/** Money is a dollar string; an absent or null amount stays unknown (D-037). */
function readAmount(
  node: JsonObject,
  key: string,
  ref: SourceRef,
  issues: IngestIssue[],
): { amountCents: number | null; amountRaw: string | null } {
  const amountRaw = textAt(node, key)
  if (amountRaw === null) return { amountCents: null, amountRaw: null }
  const amountCents = dollarsToCents(amountRaw)
  if (amountCents === null) {
    issues.push(makeIssue(ref, 'warn', 'money.unparseable', `Unparseable ${key}; left unknown`))
  }
  return { amountCents, amountRaw }
}

function parseFile(file: SourceFile, ctx: AdapterContext): CandidateBatch {
  const account = fileStem(file.path)
  const providerKey = `jobber:${account}`
  const refOf = refFactory('jobber', account, file.path, ctx)
  const issues: IngestIssue[] = []
  const doc = parseJsonFile(file, refOf(fileName(file.path)), issues)
  const data = objectAt(doc, 'data')
  if (data === null) {
    if (doc !== null) {
      issues.push(makeIssue(refOf(fileName(file.path)), 'error', 'jobber.no_data', 'No data block'))
    }
    return { ...emptyBatch(), issues }
  }

  const accountNode = objectAt(data, 'account') ?? {}
  const provider: ProviderCandidate = {
    type: 'provider',
    ref: refOf(textAt(accountNode, 'id') ?? account),
    providerKey,
    businessName: textAt(accountNode, 'name') ?? account,
    ownerName: textAt(objectAt(accountNode, 'owner'), 'name'),
    phones: compact([textAt(accountNode, 'phone')]),
    emails: [],
    website: null,
    tradesRaw: compact([textAt(accountNode, 'industry')]),
    doesNotDoRaw: [],
    declaredServiceZips: null,
    crewSize: null,
    declaredCrm: null,
    baseAddress: null,
  }

  const propertyKeyOf = (propertyId: string) => `${providerKey}:${propertyId}`
  const clients = arrayAt(objectAt(data, 'clients'), 'nodes').filter(isObject)
  const properties = clients.flatMap((client): PropertyCandidate[] =>
    arrayAt(objectAt(client, 'properties'), 'nodes')
      .filter(isObject)
      .flatMap((property) => {
        const propertyId = textAt(property, 'id')
        if (propertyId === null) return []
        const address = objectAt(property, 'address')
        return [
          {
            type: 'property',
            ref: refOf(propertyId),
            propertyKey: propertyKeyOf(propertyId),
            providerKey,
            address: {
              line1: textAt(address, 'street1'),
              line2: textAt(address, 'street2'),
              city: textAt(address, 'city'),
              state: textAt(address, 'province'),
              zip: textAt(address, 'postalCode'),
              freeText: null,
            },
            contact: {
              sourceCustomerId: textAt(client, 'id'),
              name:
                joinName(textAt(client, 'firstName'), textAt(client, 'lastName')) ??
                textAt(client, 'companyName'),
              phones: compact(arrayAt(client, 'phones').map((phone) => textAt(phone, 'number'))),
              emails: compact(arrayAt(client, 'emails').map((email) => textAt(email, 'address'))),
            },
          },
        ]
      }),
  )
  const knownProperties = new Set(properties.map((property) => property.ref.sourceRecordId))

  const jobs = arrayAt(objectAt(data, 'jobs'), 'nodes')
    .filter(isObject)
    .flatMap((job): JobCandidate[] => {
      const jobId = textAt(job, 'id')
      if (jobId === null) {
        issues.push(
          makeIssue(
            refOf(fileName(file.path)),
            'warn',
            'jobber.job_without_id',
            'Job without id skipped',
          ),
        )
        return []
      }
      const propertyId = textAt(objectAt(job, 'property'), 'id')
      if (propertyId !== null && !knownProperties.has(propertyId)) {
        issues.push(
          makeIssue(
            refOf(jobId),
            'warn',
            'jobber.unknown_property',
            'Job references an unknown property',
          ),
        )
      }
      const instructions = textAt(job, 'instructions')
      const shared = {
        type: 'job' as const,
        providerKey,
        propertyKey: propertyId === null ? null : propertyKeyOf(propertyId),
        allDay: false,
        sourceCreatedAt: isoToInstant(textAt(job, 'createdAt')),
        sourceUpdatedAt: null,
        tradeRaw: textAt(job, 'title'),
        descriptionRaw: textAt(job, 'title'),
        notesRaw: instructions,
        isRecurring: textAt(job, 'jobType') === 'RECURRING' || isObject(job['recurrence']),
        rescheduleNote: rescheduleNoteOf(instructions),
      }
      const visits = arrayAt(objectAt(job, 'visits'), 'nodes').filter(isObject)

      if (visits.length === 0) {
        const ref = refOf(jobId)
        const statusRaw = textAt(job, 'jobStatus') ?? ''
        return [
          finishJob(
            {
              ...shared,
              ref,
              kind: 'job',
              parentSourceRecordId: null,
              statusRaw,
              status: mapStatus(JOB_STATUS, statusRaw, ref, issues),
              startAt: null,
              endAt: null,
              timeBasis: null,
              completedAt: null,
              ...readAmount(job, 'total', ref, issues),
            },
            ctx,
            issues,
          ),
        ]
      }

      return visits.flatMap((visit): JobCandidate[] => {
        const visitId = textAt(visit, 'id')
        if (visitId === null) return []
        const ref = refOf(visitId)
        const statusRaw = textAt(visit, 'visitStatus') ?? ''
        const startAt = isoToInstant(textAt(visit, 'startAt'))
        const endAt = isoToInstant(textAt(visit, 'endAt'))
        return [
          finishJob(
            {
              ...shared,
              ref,
              kind: 'visit',
              parentSourceRecordId: jobId,
              statusRaw,
              status: mapStatus(VISIT_STATUS, statusRaw, ref, issues),
              startAt,
              endAt,
              timeBasis: startAt === null && endAt === null ? null : 'utc',
              completedAt: isoToInstant(textAt(visit, 'completedAt')),
              ...readAmount(visit, 'invoicedAmount', ref, issues),
            },
            ctx,
            issues,
          ),
        ]
      })
    })

  return { ...emptyBatch(), providers: [provider], properties, jobs, issues }
}

/** CRM A: one GraphQL-style export per account, `sources/jobber/<account>.json`. */
export const jobberAdapter: SourceAdapter = {
  sourceSystem: 'jobber',
  patterns: ['sources/jobber/*.json'],
  parse(files, ctx) {
    return mergeBatches(sortByPath(files).map((file) => parseFile(file, ctx)))
  },
}
