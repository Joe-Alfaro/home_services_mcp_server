/**
 * A caller mistake the agent can fix by changing one argument (R18 c). The message names the
 * field and what it accepts, and never echoes stored data (R17).
 */
export class ToolInputError extends Error {
  readonly field: string

  constructor(field: string, message: string) {
    super(`${field}: ${message}`)
    this.name = 'ToolInputError'
    this.field = field
  }
}

/** One-line error text for a failed call; unexpected failures say so without internals. */
export function errorText(error: unknown): string {
  if (error instanceof ToolInputError) return `Invalid input. ${error.message}`
  const message = error instanceof Error ? error.message : String(error)
  return `The tool failed while reading the database: ${message}. Retry once; if it fails again, report it.`
}
