import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { errorText, ToolInputError } from './errors.ts'
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
 * Runs a tool body and returns its JSON as the first text item (D-072); a ToolInputError becomes
 * an `isError` result naming the field, any other failure a generic one naming `tool`. The
 * internal error goes to stderr only, for the operator.
 */
export async function respond(tool: string, build: () => Promise<object>): Promise<CallToolResult> {
  try {
    const body = localizeTree(await build())
    return { content: [{ type: 'text', text: JSON.stringify(body) }] }
  } catch (error) {
    if (!(error instanceof ToolInputError)) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`mcp: ${tool} failed: ${message}`)
    }
    return { content: [{ type: 'text', text: errorText(tool, error) }], isError: true }
  }
}
