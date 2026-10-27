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

/**
 * One-line error text for a failed call. An unexpected failure (database, driver, bug) gets a
 * generic message naming the tool: driver text can carry SQL, relation names, hosts or stored
 * values, so it never reaches the client (R17, R18 c).
 */
export function errorText(tool: string, error: unknown): string {
  if (error instanceof ToolInputError) return `Invalid input. ${error.message}`
  return `${tool} failed because of an internal error while reading the data. Retry once; if it fails again, report that ${tool} is unavailable.`
}
