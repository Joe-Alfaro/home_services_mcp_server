import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { loadAvailability, presentOpenings } from '../availability.ts'
import type { ServerOptions } from '../context.ts'
import { loadProvider } from '../db.ts'
import { ToolInputError } from '../errors.ts'
import { respond } from '../result.ts'
import { intField, localDateField, textField } from '../schemas.ts'
import { daysBetween, presentWindow, windowInstants } from '../time.ts'

const MAX_DAYS = 31

const DESCRIPTION = `Open time slots of one provider between two local dates.

Use when you already have a providerId (from find_providers, get_provider_profile or rank_providers_for_job) and need its openings on specific dates, e.g. "is this plumber free Thursday or Friday". Openings are declared working hours minus booked CRM work (jobs, visits, scheduled estimates) and calendar blocks (all-day and recurring included), crew-aware, never before now. Each opening has start/end with the America/Chicago offset, minutes, a confidence (high/medium/low) and the reasons it is not high.

Do not use it to find which providers are free (use find_providers instead) or to pick the best provider (use rank_providers_for_job).

Parameters: providerId, from and to (local dates YYYY-MM-DD, to exclusive, at most ${String(MAX_DAYS)} days apart), minMinutes (0-720, default 30), limit (1-50, default 10).

Example: {"providerId": "prov_0123456789abcdef", "from": "2026-11-02", "to": "2026-11-05", "minMinutes": 120, "limit": 10}`

export const providerOpeningsInput = {
  providerId: textField('providerId', 64, 'prov_0123456789abcdef').describe(
    'Canonical provider id, e.g. "prov_0123456789abcdef", from find_providers, get_provider_profile or rank_providers_for_job.',
  ),
  from: localDateField(
    'from',
    'First local day to search, YYYY-MM-DD (inclusive), e.g. "2026-11-02".',
  ),
  to: localDateField(
    'to',
    'Local day to stop before, YYYY-MM-DD (exclusive), e.g. "2026-11-05" for Nov 2-4.',
  ),
  minMinutes: intField('minMinutes', 0, 720, 'minutes')
    .default(30)
    .describe('Shortest opening to return, in minutes (0-720). Default 30.'),
  limit: intField('limit', 1, 50, 'openings')
    .default(10)
    .describe('Most openings to return (1-50), earliest first. Default 10.'),
}

type Input = z.infer<z.ZodObject<typeof providerOpeningsInput>>

export async function getProviderOpenings(input: Input, options: ServerOptions) {
  const window = { from: input.from, to: input.to }
  if (input.to <= input.from) {
    throw new ToolInputError(
      'to',
      `must be a YYYY-MM-DD date after from (${input.from}); to is exclusive`,
    )
  }
  if (daysBetween(window) > MAX_DAYS) {
    throw new ToolInputError('to', `must be at most ${String(MAX_DAYS)} days after from`)
  }
  const provider = await loadProvider(options.pool, input.providerId)
  if (provider === undefined) {
    throw new ToolInputError(
      'providerId',
      'no provider has this id; ids look like "prov_" + 16 hex characters and come from find_providers, get_provider_profile or rank_providers_for_job',
    )
  }
  const availability = await loadAvailability(
    options.pool,
    [provider],
    windowInstants(window),
    options.now,
    input.minMinutes,
  )
  const found = availability.get(provider.id)
  return {
    query: { today: options.today },
    providerId: provider.id,
    name: provider.name,
    window: { ...presentWindow(window), fromDate: input.from, toDateExclusive: input.to },
    minMinutes: input.minMinutes,
    crewSize: provider.crewSize,
    capacity: found?.result.capacity ?? 1,
    hoursSource: found?.result.hoursSource ?? 'none',
    openings: presentOpenings(found, input.limit),
    sources: provider.sources,
  }
}

export function registerGetProviderOpenings(server: McpServer, options: ServerOptions): void {
  server.registerTool(
    'get_provider_openings',
    {
      title: 'Openings of one provider',
      description: DESCRIPTION,
      inputSchema: providerOpeningsInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => respond('get_provider_openings', () => getProviderOpenings(args, options)),
  )
}
