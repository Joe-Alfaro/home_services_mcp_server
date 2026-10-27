import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Confidence } from '../../availability/confidence.ts'
import { classifyJobText, type Service } from '../../normalize/trade.ts'
import {
  bestConfidence,
  loadAvailability,
  presentOpening,
  type ProviderAvailability,
} from '../availability.ts'
import type { ServerOptions } from '../context.ts'
import {
  loadConflicts,
  loadJobs,
  loadProvidersByTrade,
  type Conflict,
  type Job,
  type Provider,
} from '../db.ts'
import { mergeSources, type Source } from '../privacy.ts'
import { respond } from '../result.ts'
import { intField, textField, tradeField, windowField, zipField } from '../schemas.ts'
import { presentWindow, relativeWindow, windowInstants, WINDOWS } from '../time.ts'

const DESCRIPTION = `Rank every provider of a trade for one job near a zip in a time window, with a 0-100 score and the factors behind it, each citing its sources.

Use when the question asks who is the best fit / who to recommend for a specific job ("best plumber near 75206 for a water heater replacement this week"). The free-text service is mapped to a trade and, for water heaters, a subtype (replacement, repair, service). Factors: service history (completed jobs of that service), zip coverage (declared service area and completed work in the zip), openings in the window long enough for the job (with confidence), trade fit, and profile-vs-data conflicts. A provider with no matching history is still ranked and says "no <service> history".

Do not use it just to list providers or openings (use find_providers instead) or to look up one named provider (use get_provider_profile).

Parameters: trade (enum), service (free text, e.g. "water heater replacement"), nearZip (5-digit string), window (${WINDOWS.join(' | ')}), jobMinutes (optional 30-720; default from the service, 180 for a water heater replacement).

Example: {"trade": "plumbing", "service": "water heater replacement", "nearZip": "75206", "window": "this_week"}`

export const rankProvidersInput = {
  trade: tradeField,
  service: textField('service', 200, 'water heater replacement').describe(
    'What the job is, in plain words, e.g. "water heater replacement" or "fix leaking toilet".',
  ),
  nearZip: zipField('nearZip', 'The job\'s 5-digit zip, e.g. "75206".'),
  window: windowField(
    'window',
    `When the job should happen, in America/Chicago local days: ${WINDOWS.join(', ')}. "this_week" = Monday-Sunday containing today. Default this_week.`,
  ).default('this_week'),
  jobMinutes: intField('jobMinutes', 30, 720, 'minutes')
    .optional()
    .describe(
      'How long the job takes, in minutes, to judge openings (30-720). Default: 180 for a water heater replacement, 120 for a repair, 90 otherwise.',
    ),
}

type Input = z.infer<z.ZodObject<typeof rankProvidersInput>>

const SERVICE_LABEL: Record<Service, string> = {
  water_heater_replace: 'water heater replacement',
  water_heater_repair: 'water heater repair',
  water_heater_service: 'water heater service',
}

const SERVICE_MINUTES: Record<Service, number> = {
  water_heater_replace: 180,
  water_heater_repair: 120,
  water_heater_service: 90,
}

const CONFIDENCE_POINTS: Record<Confidence, number> = { high: 10, medium: 6, low: 2 }
const MAX_CITED_JOBS = 10

interface Factor {
  name: string
  points: number
  maxPoints: number
  detail: string
  confidence?: Confidence
  sources: Source[]
}

interface ServiceMatch {
  /** "water heater" for the water heater family, else the caller's words. */
  family: string
  label: string
  /** Completed jobs of exactly this service. */
  exact: (job: Job) => boolean
  /** Completed jobs of a related service (same family). */
  related: (job: Job) => boolean
  minutes: number
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4)
}

function serviceMatch(serviceText: string): ServiceMatch {
  const mapped = classifyJobText(serviceText)
  if (mapped.service !== null) {
    const service = mapped.service
    return {
      family: 'water heater',
      label: SERVICE_LABEL[service],
      exact: (job) => job.service === service,
      related: (job) => job.service !== service && (job.service ?? '').startsWith('water_heater'),
      minutes: SERVICE_MINUTES[service],
    }
  }
  if (mapped.trade === 'plumbing' && /water ?heater/i.test(serviceText)) {
    return {
      family: 'water heater',
      label: 'water heater work',
      exact: (job) => (job.service ?? '').startsWith('water_heater'),
      related: () => false,
      minutes: 120,
    }
  }
  const keys = words(serviceText)
  return {
    family: serviceText.trim().toLowerCase(),
    label: serviceText.trim(),
    exact: (job) => {
      const text = (job.description ?? '').toLowerCase()
      return keys.length > 0 && keys.every((key) => text.includes(key))
    },
    related: () => false,
    minutes: 90,
  }
}

function doneTime(job: Job): number {
  return (job.endAt ?? job.completedAt ?? job.startAt)?.getTime() ?? 0
}

function latestFirst(jobs: readonly Job[]): Job[] {
  return [...jobs].sort((a, b) => doneTime(b) - doneTime(a))
}

function citeJobs(jobs: readonly Job[]): Source[] {
  return mergeSources(
    ...latestFirst(jobs)
      .slice(0, MAX_CITED_JOBS)
      .map((job) => job.sources),
  )
}

function profileSources(provider: Provider): Source[] {
  const profile = provider.sources.filter((source) => source.sourceSystem === 'profiles')
  return profile.length > 0 ? profile : provider.sources
}

/**
 * Experience relative to the strongest candidate, log-scaled: 0 jobs = 0, the most experienced
 * provider = 1, and 14 vs 111 jobs stay distinguishable (a fixed cap would call both "max").
 */
function relative(count: number, best: number): number {
  if (count <= 0 || best <= 0) return 0
  return Math.log1p(count) / Math.log1p(best)
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

interface Peers {
  maxExact: number
  maxRelated: number
  maxInZip: number
}

function historyFactor(
  provider: Provider,
  exact: readonly Job[],
  related: readonly Job[],
  match: ServiceMatch,
  peers: Peers,
): Factor {
  if (exact.length === 0 && related.length === 0) {
    return {
      name: `${match.family} history`,
      points: 0,
      maxPoints: 40,
      detail: `no ${match.family} history: no completed ${match.label} jobs in any linked source`,
      sources: provider.sources,
    }
  }
  const points = round1(
    30 * relative(exact.length, peers.maxExact) + 10 * relative(related.length, peers.maxRelated),
  )
  const parts = [
    `${String(exact.length)} completed ${match.label} job(s)`,
    ...(related.length > 0 ? [`${String(related.length)} other ${match.family} job(s)`] : []),
  ]
  const shown = exact.length > MAX_CITED_JOBS ? ` (latest ${String(MAX_CITED_JOBS)} cited)` : ''
  return {
    name: `${match.family} history`,
    points,
    maxPoints: 40,
    detail: `${parts.join(' and ')}${shown}`,
    sources: exact.length > 0 ? citeJobs(exact) : citeJobs(related),
  }
}

function zipFactor(provider: Provider, inZip: readonly Job[], zip: string, peers: Peers): Factor {
  const declares = (provider.declaredZips ?? []).includes(zip)
  const points = round1((declares ? 15 : 0) + 10 * relative(inZip.length, peers.maxInZip))
  const declaredText = declares
    ? `declares ${zip} in its service area`
    : `does not declare ${zip} in its service area`
  return {
    name: 'zip coverage',
    points,
    maxPoints: 25,
    detail: `${declaredText}; ${String(inZip.length)} completed job(s) in zip ${zip}`,
    sources: mergeSources(profileSources(provider), citeJobs(inZip).slice(0, 5)),
  }
}

function availabilityFactor(
  provider: Provider,
  found: ProviderAvailability | undefined,
  minutes: number,
  windowName: string,
) {
  const all = found?.result.openings ?? []
  const fitting = all.filter((opening) => opening.minutes >= minutes)
  const presented = fitting.map((opening) =>
    presentOpening(opening, found?.hoursSources ?? new Map<number, Source[]>()),
  )
  const confidence = bestConfidence(fitting)
  const hours = Math.round(fitting.reduce((sum, opening) => sum + opening.minutes, 0) / 6) / 10
  let points = 0
  let detail = `no openings ${windowName}`
  if (confidence !== null) {
    points = 15 + CONFIDENCE_POINTS[confidence]
    detail = `${String(fitting.length)} opening(s) of ${String(minutes)}+ minutes ${windowName} (${String(hours)} h in total), best confidence ${confidence}`
  } else if (all.length > 0) {
    points = 5
    detail = `openings ${windowName} are all shorter than the ${String(minutes)} minutes the job needs`
  }
  const sources = mergeSources(...presented.slice(0, 3).map((opening) => opening.sources ?? []))
  const factor: Factor = {
    name: `openings ${windowName}`,
    points,
    maxPoints: 25,
    detail,
    confidence: confidence ?? 'low',
    sources: sources.length > 0 ? sources : profileSources(provider),
  }
  return { factor, openings: presented.slice(0, 3), confidence }
}

function tradeFactor(provider: Provider, trade: string, serviceText: string): Factor {
  const mapped = classifyJobText(serviceText).trade
  const base = { name: 'trade fit', maxPoints: 10, sources: profileSources(provider) }
  if (mapped !== null && provider.doesNotDo.includes(mapped)) {
    return { ...base, points: 0, detail: `declares it does not do ${mapped} work` }
  }
  if (mapped !== null && mapped !== trade) {
    return {
      ...base,
      points: 5,
      detail: `declares ${trade}, but "${serviceText}" reads as ${mapped} work`,
    }
  }
  return {
    ...base,
    points: 10,
    detail: `declares ${provider.trades.join(', ')}, which covers "${serviceText}"`,
  }
}

/**
 * Profile-vs-data conflicts cost a point each (at most 3): they make the profile less reliable,
 * but working outside the declared area mostly shows breadth, and work in the job's own zip is
 * evidence for the job, not against it.
 */
function conflictFactor(provider: Provider, conflicts: readonly Conflict[], zip: string): Factor {
  const counted = conflicts.filter(
    (conflict) => !(conflict.kind === 'service_area' && conflict.detail.zip === zip),
  )
  if (counted.length === 0) {
    return {
      name: 'conflicts',
      points: 0,
      maxPoints: 0,
      detail: 'no conflicts between the profile and the job data that bear on this job',
      sources:
        conflicts.length > 0 ? mergeSources(...conflicts.map((c) => c.sources)) : provider.sources,
    }
  }
  const kinds = counted.map((conflict) =>
    conflict.kind === 'service_area'
      ? `works outside declared area (${String(conflict.detail.zip)})`
      : `${conflict.kind} conflict`,
  )
  return {
    name: 'conflicts',
    points: -Math.min(counted.length, 3),
    maxPoints: 0,
    detail: `${String(counted.length)} profile-vs-data conflict(s): ${kinds.join('; ')}`,
    sources: mergeSources(...counted.map((conflict) => conflict.sources), profileSources(provider)),
  }
}

export async function rankProvidersForJob(input: Input, options: ServerOptions) {
  const window = relativeWindow(input.window, options.today)
  const match = serviceMatch(input.service)
  const minutes = input.jobMinutes ?? match.minutes
  const providers = await loadProvidersByTrade(options.pool, input.trade)
  const ids = providers.map((provider) => provider.id)
  const [completed, conflicts, availability] = await Promise.all([
    loadJobs(
      options.pool,
      `j.provider_id = ANY ($1) AND j.status = 'completed' AND j.kind <> 'estimate'`,
      [ids],
    ),
    loadConflicts(options.pool, ids),
    loadAvailability(options.pool, providers, windowInstants(window), options.now, 30),
  ])
  const windowName = input.window.replace(/_/g, ' ')

  const experience = providers.map((provider) => {
    const jobs = completed.filter((job) => job.providerId === provider.id)
    return {
      provider,
      exact: jobs.filter(match.exact),
      related: jobs.filter(match.related),
      inZip: jobs.filter((job) => job.zip === input.nearZip),
    }
  })
  const peers: Peers = {
    maxExact: Math.max(0, ...experience.map((e) => e.exact.length)),
    maxRelated: Math.max(0, ...experience.map((e) => e.related.length)),
    maxInZip: Math.max(0, ...experience.map((e) => e.inZip.length)),
  }

  const entries = experience.map(({ provider, exact, related, inZip }) => {
    const open = availabilityFactor(provider, availability.get(provider.id), minutes, windowName)
    const factors = [
      historyFactor(provider, exact, related, match, peers),
      zipFactor(provider, inZip, input.nearZip, peers),
      open.factor,
      tradeFactor(provider, input.trade, input.service),
      conflictFactor(
        provider,
        conflicts.filter((conflict) => conflict.providerId === provider.id),
        input.nearZip,
      ),
    ]
    const score = Math.round(factors.reduce((sum, factor) => sum + factor.points, 0) * 10) / 10
    return {
      providerId: provider.id,
      name: provider.name,
      score,
      confidence: open.confidence ?? 'low',
      summary: factors
        .filter((factor) => factor.name !== 'conflicts' || factor.points < 0)
        .map((factor) => factor.detail)
        .join('; '),
      factors,
      openings: open.openings,
      sources: provider.sources,
    }
  })

  const ranking = entries
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((entry, index) => ({ rank: index + 1, ...entry }))

  return {
    query: {
      trade: input.trade,
      service: input.service,
      mappedService: match.label,
      nearZip: input.nearZip,
      window: { name: input.window, ...presentWindow(window) },
      jobMinutes: minutes,
    },
    scoring:
      'score = service history (max 40: 30 for this service, 10 for related work, log-scaled against the most experienced candidate) + zip coverage (max 25: 15 for declaring the zip, 10 for completed work there, log-scaled) + openings long enough for the job (max 25: 15 if any, +10/6/2 for high/medium/low confidence) + trade fit (max 10) - 1 per profile-vs-data conflict (max 3).',
    ranking,
  }
}

export function registerRankProvidersForJob(server: McpServer, options: ServerOptions): void {
  server.registerTool(
    'rank_providers_for_job',
    {
      title: 'Rank providers for a job',
      description: DESCRIPTION,
      inputSchema: rankProvidersInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => respond(() => rankProvidersForJob(args, options)),
  )
}
