import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../../src/config.ts'
import { createServer } from '../../../src/mcp/server.ts'

/*
 * R14 + R18: the agent must learn the server's fixed "today" from the server itself. In a
 * live-agent dry run every tool used 2026-11-02, but nothing told the agent so, and it reported
 * its own system date instead (D-149). No database: instructions and tool descriptions are read
 * through an in-memory MCP client over a pool that is never queried.
 *
 * Pinned here:
 *   - The initialize result's `instructions` states the server's today as YYYY-MM-DD next to the
 *     word "today" (the configured HS_TODAY; 2026-11-02 by default), says relative windows are
 *     computed from it and names the ones the benchmark uses: "last 24 months", "next 3 days",
 *     "next 14 days" and "this week". It also tells the agent not to use its own clock/date
 *     (CALLER_CLOCK below), e.g. "Use this date, not your own clock or the caller's date".
 *   - Every tool whose answer depends on a relative window (TOOLS_WITH_RELATIVE_WINDOWS) says in its
 *     description that the window is relative to the server's today (SERVER_TODAY, e.g. "windows
 *     are relative to the server's today (query.today), not the caller's clock") and not the
 *     caller's clock (CALLER_CLOCK).
 */

const TOOLS_WITH_RELATIVE_WINDOWS = [
  'find_providers', // window: next_3_days, this_week, ...
  'get_provider_profile', // next openings over the next 30 days
  'get_scheduled_work_on_block', // [today, today + nextDays)
  'rank_providers_for_job', // window: this_week, ...
  'search_job_history_near_address', // lastMonths back from today
]

/** "the server's today" / "the server's fixed today" / the server's "today". */
const SERVER_TODAY = /\bserver['’]s (?:fixed )?(?:"today"|today)/i
/** "not your own clock", "not the caller's clock", "not your system date", ... */
const CALLER_CLOCK =
  /\bnot\b[^.\n]{0,60}?\b(?:caller['’]s|agent['’]s|your(?: own)?)\s+(?:system\s+)?(?:clock|date)\b/i

/** The date and the word "today" in one sentence, either order. */
function statesToday(date: string): RegExp {
  return new RegExp(`\\btoday\\b[^.\\n]{0,60}${date}|${date}[^.\\n]{0,60}\\btoday\\b`, 'i')
}

let open: { client: Client; close: () => Promise<void> } | undefined

/** A pool that fails loudly if anything here reaches the database. */
const unusedPool = {
  query: () => Promise.reject(new Error('no database in this test')),
  connect: () => Promise.reject(new Error('no database in this test')),
  end: () => Promise.resolve(),
  on: () => unusedPool,
} as unknown as pg.Pool

async function connect(env: Record<string, string | undefined>): Promise<Client> {
  const config = loadConfig(env)
  const server = createServer({ pool: unusedPool, today: config.today, now: config.now })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'unit-test', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  open = {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
  return client
}

afterEach(async () => {
  await open?.close()
  open = undefined
})

async function instructionsFor(env: Record<string, string | undefined>): Promise<string> {
  const client = await connect(env)
  const instructions = client.getInstructions()
  expect(instructions, 'initialize result has instructions').toBeTypeOf('string')
  return instructions ?? ''
}

describe('R14/R18: the initialize instructions state the server today', () => {
  it('R14/R18: states 2026-11-02 as today by default', async () => {
    const text = await instructionsFor({})

    expect(text).toMatch(statesToday('2026-11-02'))
  })

  it('R14/R18: states 2026-11-09 under HS_TODAY=2026-11-09, and not the default', async () => {
    const text = await instructionsFor({ HS_TODAY: '2026-11-09' })

    expect(text).toMatch(statesToday('2026-11-09'))
    expect(text).not.toContain('2026-11-02')
  })

  it('R14/R18: says relative windows are computed from that today, naming the benchmark ones', async () => {
    const text = await instructionsFor({})

    expect(text).toMatch(/relative (?:time )?windows?/i)
    expect(text).toMatch(/last 24 months/i)
    expect(text).toMatch(/next 3 days/i)
    expect(text).toMatch(/next 14 days/i)
    expect(text).toMatch(/this week/i)
  })

  it("R14/R18: tells the agent to use it instead of its own clock or the caller's date", async () => {
    const text = await instructionsFor({})

    expect(text).toMatch(CALLER_CLOCK)
  })
})

describe("R14/R18: relative-window tool descriptions point at the server's today", () => {
  it.each(TOOLS_WITH_RELATIVE_WINDOWS)(
    "R14/R18: %s says its window is relative to the server's today, not the caller's clock",
    async (name) => {
      const client = await connect({})
      const tool = (await client.listTools()).tools.find((candidate) => candidate.name === name)
      const description = tool?.description ?? ''

      expect(tool, `${name} is listed`).toBeDefined()
      expect(description).toMatch(SERVER_TODAY)
      expect(description).toMatch(CALLER_CLOCK)
    },
  )
})
