import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { loadAvailability, presentOpenings } from '../availability.ts'
import type { ServerOptions } from '../context.ts'
import { loadJobs, loadProvidersByTrade, type Job, type Provider } from '../db.ts'
import { mergeSources } from '../privacy.ts'
import { respond } from '../result.ts'
import { intField, tradeField, windowField, zipField } from '../schemas.ts'
import {
  presentWindow,
  relativeWindow,
  windowInstants,
  WINDOWS,
  SERVER_TODAY_NOTE,
} from '../time.ts'

const DESCRIPTION = `Find providers of one trade, optionally filtered by where they have worked or serve, and list their open time slots in a relative window.

Use when the question is "which <trade> providers have done work in zip X" or "who has an opening of N hours in the next 3 days / this week". "Worked in a zip" means at least one completed job or visit at a home in that zip (estimates don't count). Openings are declared working hours minus booked CRM work and calendar blocks (crew-aware), never before now, each with a confidence (high/medium/low) and reasons. Providers without a long-enough opening are listed under "excluded" with the reason.

Do not use it to compare or recommend providers for a specific job (use rank_providers_for_job instead), for one known provider's details (use get_provider_profile), or for a custom date range (use get_provider_openings with a providerId from here).

Parameters: trade (enum), workedInZip and nearZip (5-digit strings), minOpeningMinutes (15-720), window (${WINDOWS.join(' | ')}), openingsLimit (1-20).

${SERVER_TODAY_NOTE}

Example: {"trade": "handyman", "workedInZip": "75214", "minOpeningMinutes": 120, "window": "next_3_days"}`

export const findProvidersInput = {
  trade: tradeField,
  workedInZip: zipField(
    'workedInZip',
    'Only providers with completed work at a home in this 5-digit zip, e.g. "75214".',
  )
    .optional()
    .describe('Only providers with completed work at a home in this 5-digit zip, e.g. "75214".'),
  nearZip: zipField(
    'nearZip',
    'Only providers who declare this 5-digit zip in their service area or have completed work there.',
  )
    .optional()
    .describe(
      'Only providers who declare this 5-digit zip in their service area or have completed work there.',
    ),
  minOpeningMinutes: intField('minOpeningMinutes', 15, 720, 'minutes')
    .optional()
    .describe(
      'Keep only providers with at least one contiguous opening this long, in minutes (2 hours = 120). Without it, every provider is listed with its openings of 30+ minutes.',
    ),
  window: windowField(
    'window',
    `Relative window in America/Chicago local days: ${WINDOWS.join(', ')}. "next_3_days" = today and the next two days; "this_week" = Monday-Sunday containing today. Default next_3_days.`,
  ).default('next_3_days'),
  openingsLimit: intField('openingsLimit', 1, 20, 'openings')
    .default(10)
    .describe('Most openings to list per provider (1-20), earliest first. Default 10.'),
}

type Input = z.infer<z.ZodObject<typeof findProvidersInput>>

const DEFAULT_MIN_MINUTES = 30

interface Evidence {
  zip: string
  completedJobs: number
  sources: ReturnType<typeof mergeSources>
}

/** Completed jobs per provider in a zip, with their citations (latest first). */
function zipEvidence(jobs: readonly Job[], providerId: string, zip: string): Evidence | null {
  const mine = jobs.filter((job) => job.providerId === providerId && job.zip === zip)
  if (mine.length === 0) return null
  const latest = [...mine].sort((a, b) => (b.startAt?.getTime() ?? 0) - (a.startAt?.getTime() ?? 0))
  return {
    zip,
    completedJobs: mine.length,
    sources: mergeSources(...latest.slice(0, 5).map((job) => job.sources)),
  }
}

async function completedIn(options: ServerOptions, zips: string[], providerIds: string[]) {
  if (zips.length === 0 || providerIds.length === 0) return []
  return loadJobs(
    options.pool,
    `j.status = 'completed' AND j.kind <> 'estimate' AND j.zip = ANY ($1) AND j.provider_id = ANY ($2)`,
    [zips, providerIds],
  )
}

export async function findProviders(input: Input, options: ServerOptions) {
  const window = relativeWindow(input.window, options.today)
  const minMinutes = input.minOpeningMinutes ?? DEFAULT_MIN_MINUTES
  const all = await loadProvidersByTrade(options.pool, input.trade)
  const zips = [input.workedInZip, input.nearZip].filter((zip) => zip !== undefined)
  const jobs = await completedIn(
    options,
    zips,
    all.map((provider) => provider.id),
  )

  const excluded: {
    providerId: string
    name: string
    reason: string
    sources: Provider['sources']
  }[] = []
  const exclude = (provider: Provider, reason: string) => {
    excluded.push({
      providerId: provider.id,
      name: provider.name,
      reason,
      sources: provider.sources,
    })
  }

  const inArea = all.filter((provider) => {
    if (input.workedInZip !== undefined && !provider.observedZips.includes(input.workedInZip)) {
      exclude(provider, `no completed work in ${input.workedInZip}`)
      return false
    }
    if (
      input.nearZip !== undefined &&
      !(provider.declaredZips ?? []).includes(input.nearZip) &&
      !provider.observedZips.includes(input.nearZip)
    ) {
      exclude(provider, `does not serve ${input.nearZip} (not declared, no completed work there)`)
      return false
    }
    return true
  })

  const availability = await loadAvailability(
    options.pool,
    inArea,
    windowInstants(window),
    options.now,
    minMinutes,
  )

  const providers = inArea.flatMap((provider) => {
    const found = availability.get(provider.id)
    const openings = presentOpenings(found, input.openingsLimit)
    if (input.minOpeningMinutes !== undefined && openings.length === 0) {
      exclude(
        provider,
        `no opening of ${String(minMinutes)}+ minutes in ${input.window} (${window.from} to ${window.to}, end exclusive)`,
      )
      return []
    }
    const worked =
      input.workedInZip === undefined ? null : zipEvidence(jobs, provider.id, input.workedInZip)
    const near = input.nearZip === undefined ? null : zipEvidence(jobs, provider.id, input.nearZip)
    return [
      {
        providerId: provider.id,
        name: provider.name,
        aliases: provider.aliases.filter((alias) => alias !== provider.name),
        trades: provider.trades,
        serviceArea: {
          declaredZips: provider.declaredZips ?? [],
          observedZips: provider.observedZips,
        },
        ...(worked === null ? {} : { workedInZip: worked }),
        ...(near === null ? {} : { nearZip: near }),
        crewSize: provider.crewSize,
        capacity: found?.result.capacity ?? 1,
        hoursSource: found?.result.hoursSource ?? 'none',
        openings,
        confidence: provider.confidence,
        sources: provider.sources,
      },
    ]
  })

  providers.sort(
    (a, b) =>
      (a.openings[0]?.start ?? '9999').localeCompare(b.openings[0]?.start ?? '9999') ||
      a.name.localeCompare(b.name),
  )

  return {
    query: {
      today: options.today,
      trade: input.trade,
      ...(input.workedInZip === undefined ? {} : { workedInZip: input.workedInZip }),
      ...(input.nearZip === undefined ? {} : { nearZip: input.nearZip }),
      minOpeningMinutes: minMinutes,
      window: { name: input.window, ...presentWindow(window) },
    },
    providers,
    excluded: excluded.sort((a, b) => a.name.localeCompare(b.name)),
  }
}

export function registerFindProviders(server: McpServer, options: ServerOptions): void {
  server.registerTool(
    'find_providers',
    {
      title: 'Find providers with openings',
      description: DESCRIPTION,
      inputSchema: findProvidersInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => respond('find_providers', () => findProviders(args, options)),
  )
}
