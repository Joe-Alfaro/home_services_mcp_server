/*
 * R14(a): `grep -rn "new Date()\|Date.now()" src/` finds no use outside src/config.ts. The ingest
 * run's provenance timestamp is real wall-clock time, so it comes from a helper in src/config.ts.
 *
 * Expected API (src/config.ts):
 *
 *   // UTC instant without milliseconds, e.g. "2026-11-02T12:34:56Z". `clock` defaults to the
 *   // system clock; this is the only place src/ may read it. Never used for "today" or "now".
 *   export function ingestTimestamp(clock?: () => Date): string
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as config from '../../src/config.ts'
import { exportedFunction } from './pending.ts'

const SRC = path.join(config.REPO_ROOT, 'src')
const CLOCK_READ = /new Date\(\)|Date\.now\(\)/

type IngestTimestamp = (clock?: () => Date) => string

function ingestTimestamp(clock?: () => Date): string {
  return (exportedFunction(config, 'ingestTimestamp') as IngestTimestamp)(clock)
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? sourceFiles(full) : [full]
  })
}

describe('R14(a): only src/config.ts reads the system clock', () => {
  it('R14(a): no "new Date()" or "Date.now()" in src/ outside src/config.ts', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => path.relative(SRC, file) !== 'config.ts')
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .flatMap((line, index) =>
            CLOCK_READ.test(line)
              ? [`${path.relative(config.REPO_ROOT, file)}:${String(index + 1)}`]
              : [],
          ),
      )

    expect(offenders).toEqual([])
  })

  it('R14(a): ingestTimestamp formats the given clock as a UTC instant without milliseconds', () => {
    expect(ingestTimestamp(() => new Date('2026-11-02T12:34:56.789Z'))).toBe('2026-11-02T12:34:56Z')
  })

  it('R14(a): ingestTimestamp defaults to the system clock', () => {
    const before = Math.floor(Date.now() / 1000) * 1000
    const stamp = ingestTimestamp()
    const after = Date.now()

    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(Date.parse(stamp)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(stamp)).toBeLessThanOrEqual(after)
  })

  it('R14(a): the ingest CLI takes its run timestamp from ingestTimestamp()', () => {
    const cli = readFileSync(path.join(SRC, 'cli/ingest.ts'), 'utf8')

    expect(cli).toMatch(/ingestedAt:\s*ingestTimestamp\(\)/)
  })
})
