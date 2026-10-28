import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { matchStreet, parseAddress } from '../../normalize/address.ts'
import type { ServerOptions } from '../context.ts'
import { loadJobs, loadStreetIndex } from '../db.ts'
import { ToolInputError } from '../errors.ts'
import { presentJob } from '../present.ts'
import { respond } from '../result.ts'
import { intField, textField, zipField } from '../schemas.ts'
import { nextDaysWindow, presentWindow, windowInstants, SERVER_TODAY_NOTE } from '../time.ts'

const DESCRIPTION = `Upcoming booked work (scheduled or in progress) on one hundred-block of a street, e.g. the 4500 block of Live Oak St.

Use when the question is "what work is scheduled on the <N> block of <street>" or "is anyone already working on this block soon". Returns jobs, visits and estimates whose start is in [today, today + nextDays), each labelled with kind ("estimate" for quotes) and status; cancelled work is left out. Homes are shown only as block + zip.

Do not use it for past work (use search_job_history_near_address or get_property_service_history instead) or for a provider's free time (use get_provider_openings).

Parameters: street (name and type, e.g. "Live Oak St"), blockNumber (house number of the block start, e.g. 4500; any house number is rounded down to its block), zip (optional 5-digit), nextDays (1-30).

${SERVER_TODAY_NOTE}

Example: {"street": "Live Oak St", "blockNumber": 4500, "zip": "75204", "nextDays": 14}`

export const scheduledWorkInput = {
  street: textField('street', 100, 'Live Oak St').describe(
    'Street name with its type and no house number, e.g. "Live Oak St" or "Belmont Avenue".',
  ),
  blockNumber: intField('blockNumber', 0, 99999, 'house numbers').describe(
    'The hundred block, e.g. 4500 for numbers 4500-4599. Any house number is rounded down to its block.',
  ),
  zip: zipField('zip', 'Optional 5-digit zip to pin the street, e.g. "75204".')
    .optional()
    .describe('Optional 5-digit zip to pin the street, e.g. "75204".'),
  nextDays: intField('nextDays', 1, 30, 'days')
    .default(14)
    .describe('How many local days ahead to look, starting today (1-30). Default 14.'),
}

type Input = z.infer<z.ZodObject<typeof scheduledWorkInput>>

export async function getScheduledWorkOnBlock(input: Input, options: ServerOptions) {
  const index = await loadStreetIndex(options.pool)
  const parsed = parseAddress({
    line1: `${String(input.blockNumber)} ${input.street}`,
    line2: null,
    city: null,
    state: null,
    zip: input.zip ?? null,
    freeText: null,
  })
  if (parsed.streetName === null) {
    throw new ToolInputError('street', 'give a street name with its type, e.g. "Live Oak St"')
  }
  const match = matchStreet(parsed.streetName, parsed.streetType, input.zip ?? null, index)
  const where = input.zip === undefined ? 'the service area' : `zip ${input.zip}`
  if (match.status === 'ambiguous') {
    throw new ToolInputError(
      'street',
      `"${input.street}" matches more than one street in ${where}; add the street type (St, Ave, Dr…) or a zip`,
    )
  }
  const { streetName, streetType } = match
  if (streetName === null) {
    throw new ToolInputError(
      'street',
      `no street named "${input.street}" in ${where}; give the name and type as on a map, e.g. "Live Oak St"`,
    )
  }
  const block = Math.floor(input.blockNumber / 100) * 100
  const blockLabel = `${String(block)} block of ${streetName} ${streetType}`
  const window = nextDaysWindow(options.today, input.nextDays)
  const instants = windowInstants(window)
  const jobs = await loadJobs(
    options.pool,
    `j.street_name = $1 AND j.street_type = $2 AND j.block_number = $3
       AND ($4::text IS NULL OR j.zip = $4)
       AND j.status IN ('scheduled', 'in_progress')
       AND j.start_at >= $5 AND j.start_at < $6`,
    [streetName, streetType, block, input.zip ?? null, instants.from, instants.to],
  )
  return {
    query: { today: options.today },
    block: blockLabel,
    ...(input.zip === undefined ? {} : { zip: input.zip }),
    ...(match.status === 'fuzzy' ? { streetMatchedAs: `${streetName} ${streetType}` } : {}),
    window: { ...presentWindow(window), days: input.nextDays },
    count: jobs.length,
    items: jobs.map((job) => presentJob(job)),
    notes: [
      'Includes scheduled and in-progress jobs, visits and estimates (kind "estimate"); cancelled and completed work are excluded.',
    ],
  }
}

export function registerGetScheduledWorkOnBlock(server: McpServer, options: ServerOptions): void {
  server.registerTool(
    'get_scheduled_work_on_block',
    {
      title: 'Scheduled work on a block',
      description: DESCRIPTION,
      inputSchema: scheduledWorkInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => respond('get_scheduled_work_on_block', () => getScheduledWorkOnBlock(args, options)),
  )
}
