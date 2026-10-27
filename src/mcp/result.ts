import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { errorText } from './errors.ts'
import { localizeInstants } from './time.ts'

/** Every string in the body with UTC date-times shown in America/Chicago (R12 e). */
function localizeTree(value: unknown): unknown {
  if (typeof value === 'string') return localizeInstants(value)
  if (Array.isArray(value)) return value.map(localizeTree)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, localizeTree(inner)]),
    )
  }
  return value
}

/**
 * Runs a tool body and returns its JSON as the first text item (D-072); a ToolInputError or a
 * failure becomes an `isError` result naming the field.
 */
export async function respond(build: () => Promise<object>): Promise<CallToolResult> {
  try {
    const body = localizeTree(await build())
    return { content: [{ type: 'text', text: JSON.stringify(body) }] }
  } catch (error) {
    return { content: [{ type: 'text', text: errorText(error) }], isError: true }
  }
}
