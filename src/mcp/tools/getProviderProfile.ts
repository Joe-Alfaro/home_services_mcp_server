import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { normalizeBusinessName } from '../../normalize/name.ts'
import { loadAvailability, presentOpenings } from '../availability.ts'
import type { ServerOptions } from '../context.ts'
import {
  loadConflicts,
  loadProvider,
  loadProviders,
  NOT_VISIT_PARENT,
  type Conflict,
  type Provider,
} from '../db.ts'
import { ToolInputError } from '../errors.ts'
import { mergeSources } from '../privacy.ts'
import { respond } from '../result.ts'
import { intField, textField } from '../schemas.ts'
import {
  nextDaysWindow,
  presentOptional,
  presentWindow,
  windowInstants,
  SERVER_TODAY_NOTE,
} from '../time.ts'

const DESCRIPTION = `Everything known about one provider: trades, declared vs observed service area, job history counts across all their CRM accounts, the next openings, and profile-vs-data conflicts.

Use when the question names a provider ("tell me about <business>", "what's <business>'s service area / history / next openings"). The name is matched against every name the business has used (rebrands and CRM account names included), ignoring case, punctuation, "&" and Co/LLC/Inc. If several businesses match, you get "candidates" instead: call again with the providerId of the one you mean.

Do not use it to search providers by trade or zip (use find_providers instead), to rank providers for a job (use rank_providers_for_job), or for openings in a specific date range (use get_provider_openings).

Parameters: providerName (business name) or providerId (from another tool), openingsLimit (1-10 next openings, searched over the next 30 days), minMinutes (shortest opening to return, 0-720 minutes, default 30).
History counts: completed = completed jobs and visits (estimates are counted separately, never as work).

${SERVER_TODAY_NOTE}

Example: {"providerName": "Lone Star Plumbing", "openingsLimit": 3}`

export const providerProfileInput = {
  providerName: textField('providerName', 120, 'Lone Star Plumbing')
    .optional()
    .describe('Business name, e.g. "Lone Star Plumbing". Give this or providerId.'),
  providerId: textField('providerId', 64, 'prov_0123456789abcdef')
    .optional()
    .describe(
      'Canonical provider id from another tool, e.g. "prov_0123456789abcdef". Give this or providerName.',
    ),
  openingsLimit: intField('openingsLimit', 1, 10, 'openings')
    .default(3)
    .describe('How many next openings to return, 1-10. Default 3.'),
  minMinutes: intField('minMinutes', 0, 720, 'minutes')
    .default(30)
    .describe('Shortest opening to return, in minutes (0-720). Default 30.'),
}

type Input = z.infer<z.ZodObject<typeof providerProfileInput>>

const OPENINGS_HORIZON_DAYS = 30
const WEEKDAY_NAMES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

function nameKey(name: string): string {
  return normalizeBusinessName(name.replace(/&/g, ' and '))
    .replace(/\band\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 2 = a name of the business equals the query; 1 = every query word is in one of its names. */
function nameScore(provider: Provider, query: string): number {
  const key = nameKey(query)
  const names = [provider.name, ...provider.aliases].map(nameKey)
  if (names.includes(key)) return 2
  const words = key.split(' ').filter((word) => word !== '')
  if (words.length === 0) return 0
  return names.some((name) => {
    const own = new Set(name.split(' '))
    return words.every((word) => own.has(word))
  })
    ? 1
    : 0
}

async function resolveProvider(
  input: Input,
  options: ServerOptions,
): Promise<{ provider: Provider } | { candidates: Provider[] }> {
  if (input.providerId !== undefined) {
    const provider = await loadProvider(options.pool, input.providerId)
    if (provider === undefined) {
      throw new ToolInputError(
        'providerId',
        'no provider has this id; ids look like "prov_" + 16 hex characters and come from find_providers or rank_providers_for_job, or pass providerName instead',
      )
    }
    return { provider }
  }
  const query = input.providerName ?? ''
  const scored = (await loadProviders(options.pool))
    .map((provider) => ({ provider, score: nameScore(provider, query) }))
    .filter((entry) => entry.score > 0)
  const best = Math.max(0, ...scored.map((entry) => entry.score))
  const matches = scored.filter((entry) => entry.score === best).map((entry) => entry.provider)
  const [only] = matches
  if (only === undefined) {
    throw new ToolInputError(
      'providerName',
      `no provider is named like "${query}"; check the spelling, or list providers by trade with find_providers`,
    )
  }
  return matches.length === 1 ? { provider: only } : { candidates: matches }
}

function conflictSummary(conflict: Conflict): string {
  const detail = conflict.detail
  switch (conflict.kind) {
    case 'service_area':
      return `completed work in ${String(detail.zip)}, which is not in the declared service area`
    case 'trade':
      return `jobs that look like ${String(detail.observedTrade)} (${String(detail.reason).replace(/_/g, ' ')})`
    case 'crm':
      return `profile declares ${String(detail.declared)} but records also come from ${Array.isArray(detail.observedSystems) ? detail.observedSystems.join(', ') : 'other CRMs'}`
    default:
      return conflict.kind
  }
}

interface HistoryRow {
  kind: string
  status: string
  n: string
  first_at: Date | null
  last_at: Date | null
}

async function loadHistory(options: ServerOptions, provider: Provider) {
  const { rows } = await options.pool.query<HistoryRow>(
    `SELECT kind, status, count(*) AS n, min(coalesce(end_at, completed_at, start_at)) AS first_at,
            max(coalesce(end_at, completed_at, start_at)) AS last_at
       FROM v_jobs j WHERE provider_id = $1 AND ${NOT_VISIT_PARENT} GROUP BY kind, status`,
    [provider.id],
  )
  const work = rows.filter((row) => row.kind !== 'estimate')
  const count = (status: string) =>
    work.filter((row) => row.status === status).reduce((sum, row) => sum + Number(row.n), 0)
  const completed = work.filter((row) => row.status === 'completed')
  const firstDates = completed.flatMap((row) => (row.first_at === null ? [] : [row.first_at]))
  const lastDates = completed.flatMap((row) => (row.last_at === null ? [] : [row.last_at]))
  const { rows: byTrade } = await options.pool.query<{ trade: string | null; n: string }>(
    `SELECT trade, count(*) AS n FROM v_jobs j
      WHERE provider_id = $1 AND kind <> 'estimate' AND status = 'completed' AND ${NOT_VISIT_PARENT}
      GROUP BY trade ORDER BY count(*) DESC, trade`,
    [provider.id],
  )
  const { rows: converted } = await options.pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM v_sources s JOIN v_jobs j ON j.id = s.entity_id
      WHERE s.entity = 'job' AND s.method = 'estimate_to_job' AND j.provider_id = $1`,
    [provider.id],
  )
  const standaloneEstimates = rows
    .filter((row) => row.kind === 'estimate')
    .reduce((sum, row) => sum + Number(row.n), 0)
  const convertedEstimates = Number(converted[0]?.n ?? 0)
  return {
    completed: count('completed'),
    scheduled: count('scheduled'),
    inProgress: count('in_progress'),
    cancelled: count('cancelled'),
    // Work that is neither booked nor done: no slot yet, or put on hold.
    unscheduled: count('unscheduled') + count('on_hold'),
    limbo: count('limbo'),
    estimates: standaloneEstimates + convertedEstimates,
    estimatesConvertedToJobs: convertedEstimates,
    byStatus: Object.fromEntries(
      ['completed', 'scheduled', 'in_progress', 'cancelled', 'on_hold', 'unscheduled', 'limbo'].map(
        (status) => [status, count(status)],
      ),
    ),
    firstCompleted:
      firstDates.length === 0
        ? null
        : presentOptional(new Date(Math.min(...firstDates.map((d) => d.getTime())))),
    lastCompleted:
      lastDates.length === 0
        ? null
        : presentOptional(new Date(Math.max(...lastDates.map((d) => d.getTime())))),
    completedByTrade: Object.fromEntries(
      byTrade.map((row) => [row.trade ?? 'unclassified', Number(row.n)]),
    ),
    note: 'Counts jobs and visits from every linked CRM account by canonical status (byStatus); unscheduled = unscheduled + on_hold; limbo = past slot, never completed. estimates = every estimate issued (open, declined or converted into a job) and is never counted as work.',
  }
}

async function loadHours(options: ServerOptions, provider: Provider) {
  const { rows } = await options.pool.query<{
    weekday: number
    start_local: string
    end_local: string
  }>(
    `SELECT weekday, start_local, end_local FROM v_declared_hours
      WHERE provider_id = $1 ORDER BY weekday, start_local`,
    [provider.id],
  )
  return Object.fromEntries(
    WEEKDAY_NAMES.map((day, index) => {
      const spans = rows
        .filter((row) => row.weekday === index + 1)
        .map((row) => `${row.start_local}-${row.end_local}`)
      return [day, spans.length === 0 ? 'closed' : spans.join(', ')]
    }),
  )
}

export async function getProviderProfile(input: Input, options: ServerOptions) {
  if (input.providerName === undefined && input.providerId === undefined) {
    throw new ToolInputError(
      'providerName',
      'give providerName (business name, e.g. "Lone Star Plumbing") or providerId',
    )
  }
  const resolved = await resolveProvider(input, options)
  if ('candidates' in resolved) {
    return {
      ambiguous: true,
      query: { providerName: input.providerName, today: options.today },
      message:
        'Several businesses match this name. Call get_provider_profile again with the providerId you mean.',
      candidates: resolved.candidates.map((provider) => ({
        providerId: provider.id,
        name: provider.name,
        aliases: provider.aliases,
        trades: provider.trades,
        sources: provider.sources,
      })),
    }
  }
  const { provider } = resolved
  const window = nextDaysWindow(options.today, OPENINGS_HORIZON_DAYS)
  const [history, hours, conflicts, availability] = await Promise.all([
    loadHistory(options, provider),
    loadHours(options, provider),
    loadConflicts(options.pool, [provider.id]),
    loadAvailability(
      options.pool,
      [provider],
      windowInstants(window),
      options.now,
      input.minMinutes,
    ),
  ])
  const found = availability.get(provider.id)
  const openings = presentOpenings(found, input.openingsLimit)
  const declared = provider.declaredZips ?? []
  return {
    query: {
      today: options.today,
      ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
      ...(input.providerName === undefined ? {} : { providerName: input.providerName }),
      // The window the next openings were searched in (R14).
      window: presentWindow(window),
    },
    providerId: provider.id,
    name: provider.name,
    aliases: provider.aliases.filter((alias) => alias !== provider.name),
    trades: provider.trades,
    doesNotDo: provider.doesNotDo,
    serviceArea: {
      declaredZips: declared,
      observedZips: provider.observedZips,
      observedOutsideDeclared: provider.observedZips.filter((zip) => !declared.includes(zip)),
      note: 'observed = zips of completed jobs and visits.',
    },
    history,
    // `openings` and `nextOpenings` are the same list (the eval and the tests read either name).
    openings,
    nextOpenings: openings,
    availability: {
      crewSize: provider.crewSize,
      capacity: found?.result.capacity ?? 1,
      hoursSource: found?.result.hoursSource ?? 'none',
      minMinutes: input.minMinutes,
      declaredHours: hours,
      searchedUntil: presentOptional(windowInstants(window).to),
    },
    declaredCrm: provider.declaredCrm,
    conflicts: conflicts.map((conflict) => ({
      kind: conflict.kind,
      summary: conflictSummary(conflict),
      detail: conflict.detail,
      sources: conflict.sources.length > 0 ? conflict.sources : provider.sources,
    })),
    confidence: provider.confidence,
    sourceSystems: provider.sourceSystems,
    sources: mergeSources(provider.sources),
  }
}

export function registerGetProviderProfile(server: McpServer, options: ServerOptions): void {
  server.registerTool(
    'get_provider_profile',
    {
      title: 'Provider profile',
      description: DESCRIPTION,
      inputSchema: providerProfileInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => respond('get_provider_profile', () => getProviderProfile(args, options)),
  )
}
