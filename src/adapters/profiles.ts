import { parseDeclaredHours } from '../normalize/hours.ts'
import {
  arrayAt,
  compact,
  emptyBatch,
  fileName,
  fileStem,
  isObject,
  makeIssue,
  mergeBatches,
  numberAt,
  parseJsonFile,
  refFactory,
  sortByPath,
  textAt,
} from './shared.ts'
import type {
  AdapterContext,
  CandidateBatch,
  DeclaredHoursCandidate,
  IngestIssue,
  ProviderCandidate,
  SourceAdapter,
  SourceFile,
} from './types.ts'

function stringList(value: unknown, key: string): string[] {
  return compact(
    arrayAt(value, key).map((item) =>
      typeof item === 'string' && item.trim() !== '' ? item.trim() : null,
    ),
  )
}

function parseFile(file: SourceFile, ctx: AdapterContext): CandidateBatch {
  const account = fileStem(file.path)
  const refOf = refFactory('profiles', account, file.path, ctx)
  const issues: IngestIssue[] = []
  const doc = parseJsonFile(file, refOf(fileName(file.path)), issues)
  const seen = new Set<string>()

  const parsed = arrayAt(doc, 'providers')
    .filter(isObject)
    .flatMap((profile): Array<[ProviderCandidate, DeclaredHoursCandidate]> => {
      const profileId = textAt(profile, 'profile_id')
      if (profileId === null || seen.has(profileId)) {
        issues.push(
          makeIssue(
            refOf(profileId ?? fileName(file.path)),
            'warn',
            'profiles.bad_id',
            'Profile with a missing or repeated profile_id skipped',
          ),
        )
        return []
      }
      seen.add(profileId)
      const ref = refOf(profileId)
      // Each profile is its own provider until resolve links it (D-039).
      const providerKey = `profiles:${profileId}`
      const provider: ProviderCandidate = {
        type: 'provider',
        ref,
        providerKey,
        businessName: textAt(profile, 'business_name') ?? profileId,
        ownerName: textAt(profile, 'owner_name'),
        phones: compact([textAt(profile, 'phone')]),
        emails: compact([textAt(profile, 'email')]),
        website: textAt(profile, 'website'),
        tradesRaw: stringList(profile, 'trades'),
        doesNotDoRaw: stringList(profile, 'does_not_do'),
        declaredServiceZips: Array.isArray(profile['service_zips'])
          ? stringList(profile, 'service_zips')
          : null,
        crewSize: numberAt(profile, 'crew_size'),
        declaredCrm: textAt(profile, 'crm'),
        baseAddress: null,
      }

      const rawHours = profile['hours']
      const hours = parseDeclaredHours(rawHours)
      if (hours.parsed !== 'full') {
        issues.push(
          makeIssue(
            ref,
            'info',
            'profiles.hours_unparsed',
            `Declared hours parsed: ${hours.parsed}`,
          ),
        )
      }
      if (hours.alwaysOpen) {
        issues.push(
          makeIssue(
            ref,
            'info',
            'profiles.hours_always_open',
            'Declared hours are 24/7; not a working pattern',
          ),
        )
      }
      const declared: DeclaredHoursCandidate = {
        type: 'declared_hours',
        ref,
        providerKey,
        hoursRaw: typeof rawHours === 'string' ? rawHours : JSON.stringify(rawHours ?? null),
        weekly: hours.weekly,
        parsed: hours.parsed,
      }
      return [[provider, declared]]
    })

  return {
    ...emptyBatch(),
    providers: parsed.map(([provider]) => provider),
    declaredHours: parsed.map(([, declared]) => declared),
    issues,
  }
}

/** Self-declared provider profiles: one provider and one declared-hours record per profile. */
export const profilesAdapter: SourceAdapter = {
  sourceSystem: 'profiles',
  patterns: ['sources/profiles/*.json'],
  parse(files, ctx) {
    return mergeBatches(sortByPath(files).map((file) => parseFile(file, ctx)))
  },
}
