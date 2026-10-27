import { dollarsToCents } from '../normalize/money.ts'
import { localToInstant } from '../normalize/time.ts'
import {
  accountFolder,
  arrayAt,
  compact,
  emptyBatch,
  fileName,
  finishJob,
  groupBy,
  isObject,
  joinName,
  localTime,
  makeIssue,
  mapStatus,
  mergeBatches,
  numberAt,
  parseJsonFile,
  refFactory,
  rescheduleNoteOf,
  statusTable,
  textAt,
  type JsonObject,
} from './shared.ts'
import type {
  AdapterContext,
  CandidateBatch,
  IngestIssue,
  JobCandidate,
  JobStatus,
  PropertyCandidate,
  ProviderCandidate,
  SourceAdapter,
  SourceFile,
  SourceRef,
} from './types.ts'

// CRM C. Keys are "Status / SubStatus" (lower case); a row whose sub-status has no entry falls
// back to its bare Status.
const STATUS = statusTable({
  done: 'completed',
  'done pending approval': 'completed',
  canceled: 'cancelled',
  'pending / scheduled': 'scheduled',
  'pending / on hold': 'on_hold',
  'pending / waiting for parts': 'on_hold',
  'pending / waiting for client': 'on_hold',
})

// Workiz names the zone with legacy aliases; anything else is reported.
const CENTRAL_ZONES = new Set(['US/Central', 'America/Chicago', 'CST6CDT'])

function statusOf(
  status: string,
  subStatus: string | null,
  hasSlot: boolean,
  ref: SourceRef,
  issues: IngestIssue[],
): JobStatus {
  // Submitted means accepted; whether it is booked depends on having a slot.
  if (status.toLowerCase() === 'submitted') return hasSlot ? 'scheduled' : 'unscheduled'
  const full = subStatus === null ? status : `${status} / ${subStatus}`
  if (subStatus !== null && STATUS.has(full.toLowerCase())) {
    return mapStatus(STATUS, full, ref, issues)
  }
  return mapStatus(STATUS, status, ref, issues)
}

function parseAccount(
  account: string,
  files: readonly SourceFile[],
  ctx: AdapterContext,
): CandidateBatch {
  const providerKey = `workiz:${account}`
  const issues: IngestIssue[] = []
  const refIn = (file: SourceFile) => refFactory('workiz', account, file.path, ctx)
  const accountFile = files.find((file) => fileName(file.path) === 'account.json')
  const jobsFile = files.find((file) => fileName(file.path) === 'jobs.json')
  files
    .filter((file) => file !== accountFile && file !== jobsFile)
    .forEach((file) => {
      issues.push(
        makeIssue(
          refIn(file)(fileName(file.path)),
          'warn',
          'file.unrecognized',
          `Unrecognized file ${fileName(file.path)}`,
        ),
      )
    })

  const providers: ProviderCandidate[] = []
  if (accountFile !== undefined) {
    const doc = parseJsonFile(accountFile, refIn(accountFile)('account.json'), issues)
    if (isObject(doc)) {
      const ref = refIn(accountFile)(textAt(doc, 'account_id') ?? account)
      const zone = textAt(doc, 'timezone')
      if (zone !== null && !CENTRAL_ZONES.has(zone)) {
        issues.push(
          makeIssue(
            ref,
            'warn',
            'workiz.unexpected_timezone',
            `Account zone ${zone} read as America/Chicago`,
          ),
        )
      }
      providers.push({
        type: 'provider',
        ref,
        providerKey,
        businessName: textAt(doc, 'company_name') ?? account,
        ownerName: null,
        phones: compact([textAt(doc, 'phone')]),
        emails: [],
        website: null,
        tradesRaw: [],
        doesNotDoRaw: [],
        declaredServiceZips: null,
        crewSize: null,
        declaredCrm: null,
        baseAddress: null,
      })
    }
  } else if (jobsFile !== undefined) {
    issues.push(
      makeIssue(
        refIn(jobsFile)(account),
        'error',
        'workiz.missing_account',
        'No account.json in folder',
      ),
    )
  }

  if (jobsFile === undefined) return { ...emptyBatch(), providers, issues }
  const refOf = refIn(jobsFile)
  const doc = parseJsonFile(jobsFile, refOf('jobs.json'), issues)
  const rows = arrayAt(doc, 'data').filter(isObject)
  const found = numberAt(doc, 'found')
  if (found !== null && found !== rows.length) {
    issues.push(
      makeIssue(
        refOf('jobs.json'),
        'error',
        'workiz.found_mismatch',
        `found is ${String(found)} but data has ${String(rows.length)} rows`,
      ),
    )
  }
  if (isObject(doc) && doc['has_more'] === true) {
    issues.push(
      makeIssue(refOf('jobs.json'), 'error', 'workiz.has_more', 'Export says more pages exist'),
    )
  }

  // One property per distinct (ClientId, address), identified by the first job that names it.
  const properties: PropertyCandidate[] = []
  const propertyKeys = new Map<string, string>()
  function propertyKeyFor(row: JsonObject, jobId: string): string {
    const address = {
      line1: textAt(row, 'Address'),
      line2: textAt(row, 'Unit'),
      city: textAt(row, 'City'),
      state: textAt(row, 'State'),
      zip: textAt(row, 'PostalCode'),
      freeText: null,
    }
    const identity = JSON.stringify([textAt(row, 'ClientId'), address])
    const existing = propertyKeys.get(identity)
    if (existing !== undefined) return existing
    const recordId = `${jobId}#address`
    const propertyKey = `${providerKey}:${recordId}`
    propertyKeys.set(identity, propertyKey)
    properties.push({
      type: 'property',
      ref: refOf(recordId),
      propertyKey,
      providerKey,
      address,
      contact: {
        sourceCustomerId: textAt(row, 'ClientId'),
        name: joinName(textAt(row, 'FirstName'), textAt(row, 'LastName')) ?? textAt(row, 'Company'),
        phones: compact([textAt(row, 'Phone')]),
        emails: compact([textAt(row, 'Email')]),
      },
    })
    return propertyKey
  }

  const jobs = rows.flatMap((row): JobCandidate[] => {
    const jobId = textAt(row, 'UUID')
    if (jobId === null) {
      issues.push(
        makeIssue(refOf('jobs.json'), 'warn', 'workiz.row_without_id', 'A job row has no UUID'),
      )
      return []
    }
    const ref = refOf(jobId)
    const startAt = localTime(textAt(row, 'JobDateTime'), 'JobDateTime', ref, issues)
    const endAt = localTime(textAt(row, 'JobEndDateTime'), 'JobEndDateTime', ref, issues)
    const status = textAt(row, 'Status') ?? ''
    const subStatus = textAt(row, 'SubStatus')
    const amountRaw = textAt(row, 'JobTotalPrice')
    const amountCents = dollarsToCents(amountRaw)
    if (amountRaw !== null && amountCents === null) {
      issues.push(
        makeIssue(ref, 'warn', 'money.unparseable', 'Unparseable JobTotalPrice; left unknown'),
      )
    }
    const notes = textAt(row, 'JobNotes')
    const createdRaw = textAt(row, 'CreatedDate')
    const updatedRaw = textAt(row, 'LastStatusUpdate')
    return [
      finishJob(
        {
          type: 'job',
          ref,
          kind: 'job',
          providerKey,
          propertyKey: textAt(row, 'Address') === null ? null : propertyKeyFor(row, jobId),
          parentSourceRecordId: null,
          statusRaw: subStatus === null ? status : `${status} / ${subStatus}`,
          status: statusOf(status, subStatus, startAt !== null, ref, issues),
          startAt,
          endAt,
          allDay: false,
          timeBasis: startAt === null && endAt === null ? null : 'local_assumed',
          completedAt: null,
          // Zone unclear for these (G1); read as local and used only as evidence.
          sourceCreatedAt: createdRaw === null ? null : localToInstant(createdRaw),
          sourceUpdatedAt: updatedRaw === null ? null : localToInstant(updatedRaw),
          tradeRaw: textAt(row, 'JobType'),
          descriptionRaw: textAt(row, 'JobType'),
          notesRaw: notes,
          amountCents,
          amountRaw,
          isRecurring: false,
          rescheduleNote: rescheduleNoteOf(notes),
        },
        ctx,
        issues,
      ),
    ]
  })

  return { ...emptyBatch(), providers, properties, jobs, issues }
}

/** CRM C: one folder per account with account.json and a single-page jobs.json. */
export const workizAdapter: SourceAdapter = {
  sourceSystem: 'workiz',
  patterns: ['sources/workiz/*/*.json'],
  parse(files, ctx) {
    const byAccount = groupBy(files, (file) => accountFolder(file.path))
    return mergeBatches(
      [...byAccount.keys()]
        .sort()
        .map((account) => parseAccount(account, byAccount.get(account) ?? [], ctx)),
    )
  },
}
