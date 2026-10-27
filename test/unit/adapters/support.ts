import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import type {
  AdapterContext,
  Candidate,
  CandidateBatch,
  IngestIssue,
  SourceFile,
} from '../../../src/adapters/types.ts'

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures')

/** Deliberately different from `now`, so tests can tell the two apart. */
export const INGESTED_AT = '2026-11-02T12:34:56Z'
export const NOW = '2026-11-02T06:00:00Z'

/** UTC ISO instant with a trailing Z; milliseconds optional. */
export const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/

export function makeCtx(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    dataPackDir: '/fixture-pack',
    ingestedAt: INGESTED_AT,
    today: '2026-11-02',
    now: NOW,
    timeZone: 'America/Chicago',
    historyDays: 731,
    horizonDays: 31,
    ...overrides,
  }
}

function listRecursive(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? listRecursive(full) : [full]
  })
}

/**
 * Reads `test/fixtures/<sourceDir>/**` as SourceFiles whose paths mimic the data pack layout,
 * e.g. `sources/workiz/trinity_rooter/jobs.json`.
 */
export function loadFixtureFiles(sourceDir: string): SourceFile[] {
  const root = path.join(FIXTURES_DIR, sourceDir)
  return listRecursive(root)
    .sort()
    .map((full) => ({
      path: ['sources', sourceDir, ...path.relative(root, full).split(path.sep)].join('/'),
      content: readFileSync(full, 'utf8'),
    }))
}

/** Returns a copy of `files` where the JSON file at `filePath` was changed by `edit`. */
export function editJson(
  files: readonly SourceFile[],
  filePath: string,
  edit: (doc: unknown) => void,
): SourceFile[] {
  expect(files.map((file) => file.path)).toContain(filePath)
  return files.map((file) => {
    if (file.path !== filePath) return file
    const doc: unknown = JSON.parse(file.content)
    edit(doc)
    return { path: file.path, content: JSON.stringify(doc) }
  })
}

/** Returns a copy of `files` where the text file at `filePath` was changed by `edit`. */
export function editText(
  files: readonly SourceFile[],
  filePath: string,
  edit: (content: string) => string,
): SourceFile[] {
  expect(files.map((file) => file.path)).toContain(filePath)
  return files.map((file) =>
    file.path === filePath ? { path: file.path, content: edit(file.content) } : file,
  )
}

export function toMs(instant: string | null): number {
  if (instant === null) throw new Error('expected an instant, got null')
  return Date.parse(instant)
}

/** Asserts `actual` is a UTC "…Z" instant equal to `expected` (milliseconds may differ in form). */
export function expectInstant(actual: string | null, expected: string): void {
  expect(actual).toMatch(UTC_INSTANT)
  expect(toMs(actual)).toBe(Date.parse(expected))
}

/** The single item matching `predicate`; fails the test when there are zero or several. */
export function one<T>(items: readonly T[], predicate: (item: T) => boolean): T {
  const matches = items.filter(predicate)
  expect(matches).toHaveLength(1)
  const [match] = matches
  if (match === undefined) throw new Error('unreachable')
  return match
}

export function allCandidates(batch: CandidateBatch): Candidate[] {
  return [
    ...batch.providers,
    ...batch.properties,
    ...batch.jobs,
    ...batch.calendarBlocks,
    ...batch.declaredHours,
  ]
}

export function issuesFor(batch: CandidateBatch, sourceRecordId: string): IngestIssue[] {
  return batch.issues.filter((issue) => issue.ref.sourceRecordId === sourceRecordId)
}

/** Every instant-typed field on every candidate is a UTC "…Z" string or null. */
export function expectAllInstantsUtc(batch: CandidateBatch): void {
  batch.jobs.forEach((job) => {
    ;[job.startAt, job.endAt, job.completedAt, job.sourceCreatedAt, job.sourceUpdatedAt].forEach(
      (value) => {
        if (value !== null) expect(value).toMatch(UTC_INSTANT)
      },
    )
  })
  batch.calendarBlocks.forEach((block) => {
    expect(block.startAt).toMatch(UTC_INSTANT)
    expect(block.endAt).toMatch(UTC_INSTANT)
  })
}

/** R11 provenance shared by every adapter: system, account, file, record ID, run time. */
export function expectProvenance(
  batch: CandidateBatch,
  expected: { sourceSystem: string; sourceFiles: readonly string[] },
): void {
  const candidates = allCandidates(batch)
  expect(candidates.length).toBeGreaterThan(0)
  candidates.forEach((candidate) => {
    expect(candidate.ref.sourceSystem).toBe(expected.sourceSystem)
    expect(candidate.ref.sourceAccount).not.toBe('')
    expect(expected.sourceFiles).toContain(candidate.ref.sourceFile)
    expect(candidate.ref.sourceRecordId).not.toBe('')
    expect(candidate.ref.ingestedAt).toBe(INGESTED_AT)
  })
  batch.issues.forEach((issue) => {
    expect(issue.ref.sourceSystem).toBe(expected.sourceSystem)
    expect(issue.ref.ingestedAt).toBe(INGESTED_AT)
  })
}

/** Within one batch, (sourceFile, sourceRecordId) is unique per record type (R11 unique key). */
export function expectUniqueRecordIds(batch: CandidateBatch): void {
  const keys = allCandidates(batch).map(
    (candidate) => `${candidate.type}|${candidate.ref.sourceFile}|${candidate.ref.sourceRecordId}`,
  )
  expect(new Set(keys).size).toBe(keys.length)
}

/** Messages must never echo PII values (contract comment on IngestIssue.message). */
export function expectIssuesFreeOf(batch: CandidateBatch, piiValues: readonly string[]): void {
  batch.issues.forEach((issue) => {
    piiValues.forEach((value) => {
      expect(issue.message).not.toContain(value)
    })
  })
}
