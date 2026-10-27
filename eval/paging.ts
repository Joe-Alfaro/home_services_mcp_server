import { isObject, type Json, type JsonObject } from './checks/common.ts'

/** How to walk a tool's paged list: repeat `args`, adding `{ [cursorArg]: <cursorKey> }`. */
export interface PageSpec {
  /** Arguments of the first page; later pages repeat them plus the cursor. */
  args: Record<string, unknown>
  /** Response field holding one page of items. */
  itemsKey: string
  /** Response field holding the next cursor: a string, or null on the last page. */
  cursorKey: string
  /** Argument that takes the cursor. */
  cursorArg: string
  /** Gives up (a failure) after this many pages. */
  maxPages: number
}

export interface PageResult {
  items: JsonObject[]
  pages: number
  failures: string[]
}

/**
 * Follows the cursor from the first page until it is null. A page without the items array or the
 * cursor field, a repeated cursor, too many pages or a failed call ends the walk with a failure;
 * the items read so far are kept.
 */
export async function collectPages(
  fetchPage: (args: Record<string, unknown>) => Promise<Json>,
  spec: PageSpec,
): Promise<PageResult> {
  const result: PageResult = { items: [], pages: 0, failures: [] }
  const seen = new Set<string>()

  async function step(cursor: string | undefined): Promise<void> {
    if (result.pages >= spec.maxPages) {
      result.failures.push(
        `paging: ${spec.cursorKey} still set after ${String(spec.maxPages)} pages`,
      )
      return
    }
    const args = cursor === undefined ? spec.args : { ...spec.args, [spec.cursorArg]: cursor }
    let page: Json
    try {
      page = await fetchPage(args)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.failures.push(`paging: page ${String(result.pages + 1)} failed: ${message}`)
      return
    }
    result.pages += 1
    const label = `paging: page ${String(result.pages)}`
    const items = isObject(page) ? page[spec.itemsKey] : undefined
    if (!Array.isArray(items)) {
      result.failures.push(`${label} has no ${spec.itemsKey} array`)
      return
    }
    items.forEach((item, i) => {
      if (isObject(item)) result.items.push(item)
      else result.failures.push(`${label} ${spec.itemsKey}[${String(i)}] is not an object`)
    })
    const next = isObject(page) ? page[spec.cursorKey] : undefined
    if (next === null) return
    if (typeof next !== 'string' || next === '') {
      result.failures.push(`${label} has no ${spec.cursorKey} (a string, or null on the last page)`)
      return
    }
    if (seen.has(next)) {
      result.failures.push(`${label} repeats an earlier ${spec.cursorKey}`)
      return
    }
    seen.add(next)
    await step(next)
  }

  await step(undefined)
  return result
}
