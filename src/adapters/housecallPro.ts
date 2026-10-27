import { isoToInstant } from '../normalize/time.ts'
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
  objectAt,
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
  ContactPii,
  IngestIssue,
  JobCandidate,
  JobKind,
  PropertyCandidate,
  ProviderCandidate,
  RawAddress,
  SourceAdapter,
  SourceFile,
} from './types.ts'

// CRM B. Jobs and estimates share one vocabulary.
const WORK_STATUS = statusTable({
  'complete rated': 'completed',
  'complete unrated': 'completed',
  scheduled: 'scheduled',
  'pro canceled': 'cancelled',
  'user canceled': 'cancelled',
  'needs scheduling': 'unscheduled',
})

const PAGE_FILE = /^(customers|jobs|estimates)_page_(\d+)\.json$/

type PageKind = 'customers' | 'jobs' | 'estimates'

interface Page {
  kind: PageKind
  number: number
  file: SourceFile
  doc: unknown
}

function rawAddress(address: JsonObject | null): RawAddress {
  return {
    line1: textAt(address, 'street'),
    line2: textAt(address, 'street_line_2'),
    city: textAt(address, 'city'),
    state: textAt(address, 'state'),
    zip: textAt(address, 'zip'),
    freeText: null,
  }
}

function contactOf(customer: JsonObject | null): ContactPii {
  return {
    sourceCustomerId: textAt(customer, 'id'),
    name:
      joinName(textAt(customer, 'first_name'), textAt(customer, 'last_name')) ??
      textAt(customer, 'company'),
    phones: compact([textAt(customer, 'mobile_number')]),
    emails: compact([textAt(customer, 'email')]),
  }
}

function parseAccount(
  account: string,
  files: readonly SourceFile[],
  ctx: AdapterContext,
): CandidateBatch {
  const providerKey = `housecall_pro:${account}`
  const issues: IngestIssue[] = []
  const refIn = (file: SourceFile) => refFactory('housecall_pro', account, file.path, ctx)

  const companyFile = files.find((file) => fileName(file.path) === 'company.json')
  const providers: ProviderCandidate[] = []
  if (companyFile === undefined) {
    const anyFile = files[0]
    if (anyFile !== undefined) {
      issues.push(
        makeIssue(
          refIn(anyFile)(account),
          'error',
          'hcp.missing_company',
          'No company.json in folder',
        ),
      )
    }
  } else {
    const company = parseJsonFile(companyFile, refIn(companyFile)('company.json'), issues)
    if (isObject(company)) {
      const address = objectAt(company, 'address')
      providers.push({
        type: 'provider',
        ref: refIn(companyFile)(textAt(company, 'id') ?? account),
        providerKey,
        businessName: textAt(company, 'name') ?? account,
        ownerName: null,
        phones: compact([textAt(company, 'phone_number')]),
        emails: compact([textAt(company, 'support_email')]),
        website: null,
        tradesRaw: [],
        doesNotDoRaw: [],
        declaredServiceZips: null,
        crewSize: null,
        declaredCrm: null,
        baseAddress: address === null ? null : { ...rawAddress(address), line1: null, line2: null },
      })
    }
  }

  const pages = files
    .flatMap((file): Page[] => {
      const match = PAGE_FILE.exec(fileName(file.path))
      if (!match) {
        if (file !== companyFile) {
          issues.push(
            makeIssue(
              refIn(file)(fileName(file.path)),
              'warn',
              'file.unrecognized',
              `Unrecognized file ${fileName(file.path)}`,
            ),
          )
        }
        return []
      }
      const doc = parseJsonFile(file, refIn(file)(fileName(file.path)), issues)
      return [{ kind: match[1] as PageKind, number: Number(match[2]), file, doc }]
    })
    // G3: numeric page order, so page_10 sorts after page_2.
    .sort((a, b) => a.number - b.number)
  const pagesOf = (kind: PageKind) => pages.filter((page) => page.kind === kind)

  /** Rows of one kind, first occurrence wins; repeats across pages are reported (D-033). */
  function uniqueRows(kind: PageKind): Array<{ row: JsonObject; id: string; file: SourceFile }> {
    const seen = new Map<string, SourceFile>()
    const rows = pagesOf(kind).flatMap(({ file, doc }) =>
      arrayAt(doc, kind)
        .filter(isObject)
        .flatMap((row) => {
          const id = textAt(row, 'id')
          if (id === null) {
            issues.push(
              makeIssue(
                refIn(file)(fileName(file.path)),
                'warn',
                'hcp.row_without_id',
                `A ${kind} row has no id`,
              ),
            )
            return []
          }
          const first = seen.get(id)
          if (first !== undefined) {
            issues.push(
              makeIssue(
                refIn(first)(id),
                'warn',
                'hcp.duplicate_page_row',
                `${id} appears on ${fileName(first.path)} and ${fileName(file.path)}; kept the first`,
              ),
            )
            return []
          }
          seen.set(id, file)
          return [{ row, id, file }]
        }),
    )
    // R1 (d): the unique count must equal total_items on the first page.
    const firstPage = pagesOf(kind)[0]
    const totalItems = firstPage === undefined ? null : numberAt(firstPage.doc, 'total_items')
    if (firstPage !== undefined && totalItems !== null && totalItems !== rows.length) {
      issues.push(
        makeIssue(
          refIn(firstPage.file)(fileName(firstPage.file.path)),
          'error',
          'hcp.total_items_mismatch',
          `${kind}: ${String(rows.length)} unique rows but total_items is ${String(totalItems)}`,
        ),
      )
    }
    return rows
  }

  const propertyKeyOf = (addressId: string) => `${providerKey}:${addressId}`
  const properties: PropertyCandidate[] = uniqueRows('customers').flatMap(({ row, file }) =>
    arrayAt(row, 'addresses')
      .filter(isObject)
      .flatMap((address): PropertyCandidate[] => {
        const addressId = textAt(address, 'id')
        if (addressId === null) return []
        return [
          {
            type: 'property',
            ref: refIn(file)(addressId),
            propertyKey: propertyKeyOf(addressId),
            providerKey,
            address: rawAddress(address),
            contact: contactOf(row),
          },
        ]
      }),
  )
  const knownAddresses = new Set(properties.map((property) => property.ref.sourceRecordId))

  function toJob(kind: JobKind, row: JsonObject, id: string, file: SourceFile): JobCandidate {
    const ref = refIn(file)(id)
    const address = objectAt(row, 'address')
    const addressId = textAt(address, 'id')
    // An address that no customers page lists still becomes a property, derived from the row.
    if (addressId !== null && !knownAddresses.has(addressId)) {
      knownAddresses.add(addressId)
      properties.push({
        type: 'property',
        ref: refIn(file)(`${id}#address`),
        propertyKey: propertyKeyOf(addressId),
        providerKey,
        address: rawAddress(address),
        contact: contactOf(objectAt(row, 'customer')),
      })
      issues.push(
        makeIssue(
          ref,
          'info',
          'hcp.address_not_in_customers',
          'Address only appears on the job row',
        ),
      )
    }
    const schedule = objectAt(row, 'schedule')
    const startAt = localTime(textAt(schedule, 'scheduled_start'), 'scheduled_start', ref, issues)
    const endAt = localTime(textAt(schedule, 'scheduled_end'), 'scheduled_end', ref, issues)
    const completedAt = localTime(
      textAt(objectAt(row, 'work_timestamps'), 'completed_at'),
      'completed_at',
      ref,
      issues,
    )
    const statusRaw = textAt(row, 'work_status') ?? ''
    const notes = textAt(row, 'notes')
    const description = textAt(row, 'description')
    const amountCents =
      kind === 'estimate' ? approvedOptionCents(row) : numberAt(row, 'total_amount')
    if (amountCents !== null && !Number.isInteger(amountCents)) {
      issues.push(makeIssue(ref, 'warn', 'money.not_integer_cents', 'Amount is not whole cents'))
    }
    return finishJob(
      {
        type: 'job',
        ref,
        kind,
        providerKey,
        propertyKey: addressId === null ? null : propertyKeyOf(addressId),
        parentSourceRecordId: null,
        statusRaw,
        status: mapStatus(WORK_STATUS, statusRaw, ref, issues),
        startAt,
        endAt,
        allDay: false,
        timeBasis: startAt === null && endAt === null ? null : 'local_assumed',
        completedAt,
        sourceCreatedAt: isoToInstant(textAt(row, 'created_at')),
        sourceUpdatedAt: null,
        tradeRaw: description,
        descriptionRaw: description,
        notesRaw: notes,
        amountCents: amountCents !== null && Number.isInteger(amountCents) ? amountCents : null,
        amountRaw: amountCents === null ? null : String(amountCents),
        isRecurring: false,
        rescheduleNote: rescheduleNoteOf(notes),
      },
      ctx,
      issues,
    )
  }

  const jobs = [
    ...uniqueRows('jobs').map(({ row, id, file }) => toJob('job', row, id, file)),
    ...uniqueRows('estimates').map(({ row, id, file }) => toJob('estimate', row, id, file)),
  ]
  return { ...emptyBatch(), providers, properties, jobs, issues }
}

/** An estimate's value is its approved option, if any; otherwise unknown. */
function approvedOptionCents(row: JsonObject): number | null {
  const approved = arrayAt(row, 'options')
    .filter(isObject)
    .find((option) => textAt(option, 'approval_status') === 'approved')
  return approved === undefined ? null : numberAt(approved, 'total_amount')
}

/** CRM B: one folder per company with company.json and numbered pages. Amounts are cents. */
export const housecallProAdapter: SourceAdapter = {
  sourceSystem: 'housecall_pro',
  patterns: ['sources/housecall_pro/*/*.json'],
  parse(files, ctx) {
    const byAccount = groupBy(files, (file) => accountFolder(file.path))
    return mergeBatches(
      [...byAccount.keys()]
        .sort()
        .map((account) => parseAccount(account, byAccount.get(account) ?? [], ctx)),
    )
  },
}
