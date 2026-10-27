import { describe, expect, it } from 'vitest'
import type { Json } from '../../../eval/checks/common.ts'
import { collectPages, type PageSpec } from '../../../eval/paging.ts'

// The eval reads Q1's paged job list to the end (D-127); these pin how it follows the cursor.

const SPEC: PageSpec = {
  args: { address: 'x', limit: 2 },
  itemsKey: 'jobs',
  cursorKey: 'nextCursor',
  cursorArg: 'cursor',
  maxPages: 5,
}

/** A fake tool: page n (cursor "c<n>") answers pages[n]; records every call's arguments. */
function fakeTool(pages: Json[]) {
  const calls: Record<string, unknown>[] = []
  async function fetchPage(args: Record<string, unknown>): Promise<Json> {
    calls.push(args)
    const cursor = typeof args.cursor === 'string' ? Number(args.cursor.slice(1)) : 0
    const page = pages[cursor]
    if (page === undefined) throw new Error(`no page ${String(cursor)}`)
    return Promise.resolve(page)
  }
  return { calls, fetchPage }
}

describe('collectPages', () => {
  it('follows nextCursor until null, repeating the arguments plus the cursor', async () => {
    const tool = fakeTool([
      { jobs: [{ id: 1 }, { id: 2 }], nextCursor: 'c1' },
      { jobs: [{ id: 3 }, { id: 4 }], nextCursor: 'c2' },
      { jobs: [{ id: 5 }], nextCursor: null },
    ])
    const result = await collectPages(tool.fetchPage, SPEC)
    expect(result).toEqual({
      items: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
      pages: 3,
      failures: [],
    })
    expect(tool.calls).toEqual([
      { address: 'x', limit: 2 },
      { address: 'x', limit: 2, cursor: 'c1' },
      { address: 'x', limit: 2, cursor: 'c2' },
    ])
  })

  it('fails a response with no items array or no cursor field', async () => {
    const noItems = await collectPages(fakeTool([{ groups: [] }]).fetchPage, SPEC)
    expect(noItems.failures).toEqual(['paging: page 1 has no jobs array'])

    const noCursor = await collectPages(fakeTool([{ jobs: [{ id: 1 }] }]).fetchPage, SPEC)
    expect(noCursor.items).toEqual([{ id: 1 }])
    expect(noCursor.failures).toEqual([expect.stringContaining('page 1 has no nextCursor')])
  })

  it('stops on a repeated cursor and after maxPages', async () => {
    const loop = await collectPages(
      fakeTool([
        { jobs: [{ id: 1 }], nextCursor: 'c1' },
        { jobs: [{ id: 2 }], nextCursor: 'c1' },
      ]).fetchPage,
      SPEC,
    )
    expect(loop.failures).toEqual(['paging: page 2 repeats an earlier nextCursor'])

    const endless = Array.from({ length: 10 }, (_, i) => ({
      jobs: [{ id: i }],
      nextCursor: `c${String(i + 1)}`,
    }))
    const capped = await collectPages(fakeTool(endless).fetchPage, SPEC)
    expect(capped.pages).toBe(5)
    expect(capped.failures).toEqual(['paging: nextCursor still set after 5 pages'])
  })

  it('reports a failed call with its page number and keeps earlier items', async () => {
    const result = await collectPages(
      fakeTool([{ jobs: [{ id: 1 }], nextCursor: 'c7' }]).fetchPage,
      SPEC,
    )
    expect(result.items).toEqual([{ id: 1 }])
    expect(result.failures).toEqual(['paging: page 2 failed: no page 7'])
  })
})
