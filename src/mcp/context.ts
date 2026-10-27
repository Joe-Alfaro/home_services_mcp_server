import type pg from 'pg'

/** What every tool reads from: a pool logged in as hsmcp_reader and the service's clock (R14). */
export interface ServerOptions {
  pool: pg.Pool
  /** "YYYY-MM-DD" in America/Chicago. */
  today: string
  /** UTC instant; openings never start before it. */
  now: string
}
