import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { resolveCallerAddress } from '../address.ts'
import type { ServerOptions } from '../context.ts'
import { loadJobs } from '../db.ts'
import { presentJob } from '../present.ts'
import { mergeSources, readSources } from '../privacy.ts'
import { respond } from '../result.ts'
import { textField } from '../schemas.ts'

const DESCRIPTION = `Service history of one home: which providers worked there, when, and what was done, plus cancelled and upcoming jobs labelled by status.

Use when the question names one specific address ("has anyone serviced <address>", "who worked on <address> and what did they do"). The address is normalized like the source data (St/Street, Apt/#/Unit, case, ZIP+4, missing zip), so variants match the same home; a different unit or the same number on another street is a different home. Each service appears once even when several sources recorded it (an approved estimate is folded into the job created from it). Homeowner names and contacts are never returned.

Do not use it for work near an address or on a whole block (use search_job_history_near_address or get_scheduled_work_on_block instead), or for a provider's overall history (use get_provider_profile).

Parameters: address (house number, street, optional unit, city, state, 5-digit zip), includeEstimates (default false).

Example: {"address": "5823 Belmont Ave, Dallas, TX 75206"}`

export const propertyHistoryInput = {
  address: textField('address', 200, '5823 Belmont Ave, Dallas, TX 75206').describe(
    'The home\'s street address: house number, street, optional unit (e.g. "Apt B"), city, state and 5-digit zip, e.g. "5823 Belmont Ave, Dallas, TX 75206".',
  ),
  includeEstimates: z
    .boolean({ error: 'includeEstimates must be true or false' })
    .default(false)
    .describe(
      'Also list standalone estimates (quotes that never became a job), labelled kind "estimate". Default false.',
    ),
}

type Input = z.infer<z.ZodObject<typeof propertyHistoryInput>>

export async function getPropertyServiceHistory(input: Input, options: ServerOptions) {
  const caller = await resolveCallerAddress(options.pool, input.address)
  const { rows } = await options.pool.query<{
    block_label: string | null
    zip: string | null
    zip_inferred: boolean
    has_unit: boolean
    confidence: string
    sources: unknown
  }>(
    `SELECT block_label, zip, zip_inferred, has_unit, confidence, sources
       FROM v_properties WHERE address_key_hash = $1`,
    [caller.keyHash],
  )
  const [home] = rows
  const houseNumber = caller.normalized.houseNumber
  const allowed = houseNumber === null ? [] : [houseNumber]
  const property = {
    address: input.address,
    block: home?.block_label ?? caller.normalized.blockLabel,
    zip: home?.zip ?? caller.normalized.zip,
    ...(caller.normalized.unit === null ? {} : { unit: caller.normalized.unit }),
  }
  if (home === undefined) {
    return {
      query: { today: options.today },
      property: { ...property, matched: false },
      count: 0,
      items: [],
      notes: [
        'No source has a job at this exact address (unit included). Check the house number, street and unit, or use search_job_history_near_address for nearby work.',
      ],
    }
  }
  const jobs = await loadJobs(
    options.pool,
    `j.address_key_hash = $1 AND ($2 OR j.kind <> 'estimate')`,
    [caller.keyHash, input.includeEstimates],
  )
  // Undated work (no slot in any source) can't be placed in time; it is listed apart.
  const items = jobs.filter((job) => job.startAt !== null).map((job) => presentJob(job, allowed))
  const undated = jobs.filter((job) => job.startAt === null).map((job) => presentJob(job, allowed))
  const providers = new Set(
    jobs.filter((job) => job.status === 'completed').map((job) => job.providerId),
  )
  return {
    query: { today: options.today },
    property: {
      ...property,
      matched: true,
      zipInferred: home.zip_inferred,
      confidence: Number(home.confidence),
      sources: mergeSources(readSources(home.sources)),
    },
    summary: {
      completed: jobs.filter((job) => job.status === 'completed').length,
      providersWithCompletedWork: providers.size,
      cancelled: jobs.filter((job) => job.status === 'cancelled').length,
      upcoming: jobs.filter((job) => job.status === 'scheduled' || job.status === 'in_progress')
        .length,
    },
    count: items.length,
    items,
    ...(undated.length === 0 ? {} : { undated }),
    notes: [
      'One item per service; "status" says whether it was completed, cancelled or is still scheduled.',
    ],
  }
}

export function registerGetPropertyServiceHistory(server: McpServer, options: ServerOptions): void {
  server.registerTool(
    'get_property_service_history',
    {
      title: 'Service history of a home',
      description: DESCRIPTION,
      inputSchema: propertyHistoryInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      respond('get_property_service_history', () => getPropertyServiceHistory(args, options)),
  )
}
