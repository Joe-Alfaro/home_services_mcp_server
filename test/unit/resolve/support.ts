import type {
  CalendarBlockCandidate,
  JobCandidate,
  PropertyCandidate,
  ProviderCandidate,
  RawAddress,
  SourceRef,
  SourceSystem,
} from '../../../src/adapters/types.ts'

/*
 * Builders for invented resolver inputs. Every name, phone, email and address here is made up;
 * phones use the 555-01xx fictional range.
 */

export const INGESTED_AT = '2026-11-02T12:34:56Z'

export function ref(
  sourceSystem: SourceSystem,
  sourceAccount: string,
  sourceRecordId: string,
  sourceFile = `sources/${sourceSystem}/${sourceAccount}.json`,
): SourceRef {
  return { sourceSystem, sourceAccount, sourceFile, sourceRecordId, ingestedAt: INGESTED_AT }
}

export function providerKeyOf(sourceSystem: SourceSystem, sourceAccount: string): string {
  return `${sourceSystem}:${sourceAccount}`
}

export function provider(
  sourceSystem: SourceSystem,
  sourceAccount: string,
  fields: Partial<Omit<ProviderCandidate, 'type' | 'ref' | 'providerKey'>> = {},
): ProviderCandidate {
  return {
    type: 'provider',
    ref: ref(sourceSystem, sourceAccount, sourceAccount),
    providerKey: providerKeyOf(sourceSystem, sourceAccount),
    businessName: sourceAccount,
    ownerName: null,
    phones: [],
    emails: [],
    website: null,
    tradesRaw: [],
    doesNotDoRaw: [],
    declaredServiceZips: null,
    crewSize: null,
    declaredCrm: null,
    baseAddress: null,
    ...fields,
  }
}

export function address(fields: Partial<RawAddress>): RawAddress {
  return { line1: null, line2: null, city: null, state: null, zip: null, freeText: null, ...fields }
}

export function property(
  sourceSystem: SourceSystem,
  sourceAccount: string,
  nativeId: string,
  raw: RawAddress,
  contact: PropertyCandidate['contact'] = null,
): PropertyCandidate {
  return {
    type: 'property',
    ref: ref(sourceSystem, sourceAccount, `${nativeId}#address`),
    propertyKey: `${sourceSystem}:${sourceAccount}:${nativeId}`,
    providerKey: providerKeyOf(sourceSystem, sourceAccount),
    address: raw,
    contact,
  }
}

export function job(
  sourceSystem: SourceSystem,
  sourceAccount: string,
  sourceRecordId: string,
  fields: Partial<Omit<JobCandidate, 'type' | 'ref' | 'providerKey'>> = {},
): JobCandidate {
  return {
    type: 'job',
    ref: ref(sourceSystem, sourceAccount, sourceRecordId),
    kind: 'job',
    providerKey: providerKeyOf(sourceSystem, sourceAccount),
    propertyKey: null,
    parentSourceRecordId: null,
    statusRaw: 'scheduled',
    status: 'scheduled',
    startAt: null,
    endAt: null,
    allDay: false,
    timeBasis: 'local_assumed',
    completedAt: null,
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    tradeRaw: null,
    descriptionRaw: null,
    notesRaw: null,
    amountCents: null,
    amountRaw: null,
    isRecurring: false,
    rescheduleNote: null,
    ...fields,
  }
}

export function block(
  sourceAccount: string,
  uid: string,
  startAt: string,
  endAt: string,
  fields: Partial<Omit<CalendarBlockCandidate, 'type' | 'ref' | 'providerKey'>> = {},
): CalendarBlockCandidate {
  return {
    type: 'calendar_block',
    ref: ref('ics', sourceAccount, `${uid}@${startAt}`, `sources/calendars/${sourceAccount}.ics`),
    providerKey: providerKeyOf('ics', sourceAccount),
    startAt,
    endAt,
    allDay: false,
    timeBasis: 'explicit_zone',
    busy: true,
    category: 'work',
    summaryRaw: null,
    recurrence: null,
    ...fields,
  }
}

/** "sourceSystem:sourceRecordId" for comparing link refs without the other fields. */
export function refId(r: SourceRef): string {
  return `${r.sourceSystem}:${r.sourceRecordId}`
}
