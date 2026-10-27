import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkCommon,
  merge,
  type CheckResult,
  type Json,
  type JsonObject,
} from './checks/common.ts'
import { checkQ1, checkQ1Pages, type Q1Expected } from './checks/q1.ts'
import { checkQ2, type Q2Expected } from './checks/q2.ts'
import { checkQ3, type Q3Expected } from './checks/q3.ts'
import { checkQ4, type Q4Expected } from './checks/q4.ts'
import { checkQ5, type Q5Expected } from './checks/q5.ts'
import { checkQ6, type Q6Expected } from './checks/q6.ts'
import type { PageSpec } from './paging.ts'

const expectedDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'expected')

/** Reads eval/expected/<id>.json; the files are hand-checked data, so the shape is asserted, not parsed. */
export function loadExpected(id: string): unknown {
  return JSON.parse(readFileSync(path.join(expectedDir, `${id}.json`), 'utf8'))
}

export interface Question {
  id: string
  text: string
  /** The one tool from the ARCHITECTURE.md table that answers this question (R18 d). */
  tool: string
  args: Record<string, unknown>
  check: (payload: Json) => CheckResult
  /** Fails when the answer (the first call's text) is this many bytes or more. */
  maxResponseBytes?: number
  /**
   * A paged list to read to the end after the answer (follow-up calls, not retries); `check` gets
   * the answer and every item of every page.
   */
  pages?: PageSpec & { check: (payload: Json, items: JsonObject[]) => CheckResult }
}

/** Q1's default answer must fit a live agent's context (D-127: summary mode). */
export const Q1_MAX_RESPONSE_BYTES = 50_000

/** Common assertions (R12 e, R17, R19) plus the question's own expected-answer check. */
function withCommon(
  specific: (payload: Json) => CheckResult,
  options: { allowedHouseNumbers: string[]; entity?: boolean },
) {
  return (payload: Json) => merge(checkCommon(payload, options), specific(payload))
}

export function buildQuestions(): Question[] {
  const q1 = loadExpected('q1') as Q1Expected
  const q2 = loadExpected('q2') as Q2Expected
  const q3 = loadExpected('q3') as Q3Expected
  const q4 = loadExpected('q4') as Q4Expected
  const q5 = loadExpected('q5') as Q5Expected
  const q6 = loadExpected('q6') as Q6Expected
  const q1Args = {
    address: '4512 Live Oak St, Dallas, TX 75204',
    radiusMiles: 0.5,
    lastMonths: 24,
    groupBy: 'trade',
  }
  return [
    {
      id: 'Q1',
      text: 'What home services have been done within half a mile of 4512 Live Oak St, Dallas, TX 75204 in the last 24 months, grouped by trade?',
      tool: 'search_job_history_near_address',
      args: q1Args,
      check: withCommon((p) => checkQ1(p, q1), { allowedHouseNumbers: ['4512'] }),
      maxResponseBytes: Q1_MAX_RESPONSE_BYTES,
      pages: {
        args: { ...q1Args, limit: 100 },
        itemsKey: 'jobs',
        cursorKey: 'nextCursor',
        cursorArg: 'cursor',
        maxPages: 50,
        check: (payload, items) =>
          merge(
            checkCommon({ jobs: items }, { allowedHouseNumbers: ['4512'] }),
            checkQ1Pages(payload, items, q1),
          ),
      },
    },
    {
      id: 'Q2',
      text: 'Which handymen have done work in zip 75214 and have an opening of at least 2 hours in the next 3 days?',
      tool: 'find_providers',
      args: {
        trade: 'handyman',
        workedInZip: '75214',
        minOpeningMinutes: 120,
        window: 'next_3_days',
      },
      check: withCommon((p) => checkQ2(p, q2), { allowedHouseNumbers: [] }),
    },
    {
      id: 'Q3',
      text: 'What work is already scheduled on the 4500 block of Live Oak St in the next 14 days?',
      tool: 'get_scheduled_work_on_block',
      args: { street: 'Live Oak St', blockNumber: 4500, zip: '75204', nextDays: 14 },
      check: withCommon((p) => checkQ3(p, q3), { allowedHouseNumbers: [] }),
    },
    {
      id: 'Q4',
      text: 'Show me everything we know about Lone Star Plumbing: trades, service area, job history, and next 3 openings.',
      tool: 'get_provider_profile',
      args: { providerName: 'Lone Star Plumbing', openingsLimit: 3 },
      check: withCommon((p) => checkQ4(p, q4), { allowedHouseNumbers: [], entity: true }),
    },
    {
      id: 'Q5',
      text: 'Has any provider serviced 5823 Belmont Ave, Dallas, TX 75206 before? Who, when, and what was done?',
      tool: 'get_property_service_history',
      args: { address: '5823 Belmont Ave, Dallas, TX 75206' },
      check: withCommon((p) => checkQ5(p, q5), { allowedHouseNumbers: ['5823'] }),
    },
    {
      id: 'Q6',
      text: 'Which plumber near 75206 is the best fit for a water heater replacement this week, and why?',
      tool: 'rank_providers_for_job',
      args: {
        trade: 'plumbing',
        service: 'water heater replacement',
        nearZip: '75206',
        window: 'this_week',
      },
      check: withCommon((p) => checkQ6(p, q6), { allowedHouseNumbers: [] }),
    },
  ]
}
