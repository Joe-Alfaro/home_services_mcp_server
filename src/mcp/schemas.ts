import { z } from 'zod'
import { TRADES } from '../normalize/trade.ts'
import { isLocalDate, WINDOWS } from './time.ts'

/*
 * Input fields shared by the tools (R18 b-c). Every message names the field and what it accepts,
 * because the SDK returns these messages to the agent verbatim when validation fails.
 */

const tradeList = TRADES.join(', ')
const windowList = WINDOWS.join(', ')

export const tradeField = z
  .enum(TRADES, { error: `trade must be one of: ${tradeList}` })
  .describe(`Canonical trade, one of: ${tradeList}.`)

export function zipField(field: string, description: string) {
  return z
    .string({ error: `${field} must be a 5-digit zip string, e.g. "75206"` })
    .regex(/^\d{5}$/, `${field} must be a 5-digit zip string, e.g. "75206" (no ZIP+4)`)
    .describe(description)
}

export function localDateField(field: string, description: string) {
  return z
    .string({ error: `${field} must be a local date in YYYY-MM-DD (ISO 8601) form` })
    .refine(
      isLocalDate,
      `${field} must be a real local date in YYYY-MM-DD (ISO 8601) form, e.g. "2026-11-02"; relative words like "tomorrow" are not accepted`,
    )
    .describe(description)
}

export function windowField(field: string, description: string) {
  return z.enum(WINDOWS, { error: `${field} must be one of: ${windowList}` }).describe(description)
}

export function intField(field: string, min: number, max: number, unit: string) {
  return z
    .number({
      error: `${field} must be a whole number of ${unit} from ${String(min)} to ${String(max)}`,
    })
    .int(`${field} must be a whole number of ${unit} from ${String(min)} to ${String(max)}`)
    .min(
      min,
      `${field} must be at least ${String(min)} ${unit} (accepted ${String(min)}-${String(max)})`,
    )
    .max(
      max,
      `${field} must be at most ${String(max)} ${unit} (accepted ${String(min)}-${String(max)})`,
    )
}

export function textField(field: string, maxLength: number, example: string) {
  return z
    .string({ error: `${field} must be a non-empty string, e.g. "${example}"` })
    .trim()
    .min(1, `${field} must not be empty; give e.g. "${example}"`)
    .max(maxLength, `${field} must be at most ${String(maxLength)} characters`)
}
