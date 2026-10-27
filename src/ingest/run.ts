import type {
  AdapterContext,
  Candidate,
  CandidateBatch,
  IngestIssue,
  SourceAdapter,
  SourceFile,
  SourceSystem,
} from '../adapters/types.ts'

export interface SourceResult {
  sourceSystem: SourceSystem
  files: string[]
  batch: CandidateBatch
}

export interface SourceSummary {
  sourceSystem: SourceSystem
  filesRead: number
  records: Record<Candidate['type'], number>
  jobsByKind: Record<string, number>
  jobsByStatus: Record<string, number>
  issues: Record<IngestIssue['severity'], number>
  issueCodes: Record<string, number>
}

export interface IngestSummary {
  sources: SourceSummary[]
  /** Files under sources/ that no adapter claimed (R1 c: nothing is skipped silently). */
  unclaimedFiles: string[]
  totals: { records: number; errors: number; unmappedStatuses: number }
}

/** Runs every adapter on the files it claims. Pure apart from what `readFiles` does. */
export function runAdapters(
  adapters: readonly SourceAdapter[],
  claimed: ReadonlyMap<SourceSystem, readonly string[]>,
  readFiles: (paths: readonly string[]) => SourceFile[],
  ctx: AdapterContext,
): SourceResult[] {
  return adapters.map((adapter) => {
    const files = [...(claimed.get(adapter.sourceSystem) ?? [])]
    return {
      sourceSystem: adapter.sourceSystem,
      files,
      batch: adapter.parse(readFiles(files), ctx),
    }
  })
}

export function candidatesOf(batch: CandidateBatch): Candidate[] {
  return [
    ...batch.providers,
    ...batch.properties,
    ...batch.jobs,
    ...batch.calendarBlocks,
    ...batch.declaredHours,
  ]
}

function countBy<T>(items: readonly T[], keyOf: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = keyOf(item)
    counts[key] = (counts[key] ?? 0) + 1
    return counts
  }, {})
}

export function summarize(
  results: readonly SourceResult[],
  unclaimedFiles: readonly string[],
): IngestSummary {
  const sources = results.map(({ sourceSystem, files, batch }): SourceSummary => {
    const severities = countBy(batch.issues, (issue) => issue.severity)
    return {
      sourceSystem,
      filesRead: files.length,
      records: {
        provider: batch.providers.length,
        property: batch.properties.length,
        job: batch.jobs.length,
        calendar_block: batch.calendarBlocks.length,
        declared_hours: batch.declaredHours.length,
      },
      jobsByKind: countBy(batch.jobs, (job) => job.kind),
      jobsByStatus: countBy(batch.jobs, (job) => job.status),
      issues: {
        info: severities['info'] ?? 0,
        warn: severities['warn'] ?? 0,
        error: severities['error'] ?? 0,
      },
      issueCodes: countBy(batch.issues, (issue) => issue.code),
    }
  })
  return {
    sources,
    unclaimedFiles: [...unclaimedFiles],
    totals: {
      records: results.reduce((sum, { batch }) => sum + candidatesOf(batch).length, 0),
      errors: sources.reduce((sum, source) => sum + source.issues.error, 0),
      unmappedStatuses: sources.reduce(
        (sum, source) => sum + (source.issueCodes['status.unmapped'] ?? 0),
        0,
      ),
    },
  }
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).filter(([, count]) => count > 0)
  return entries.length === 0
    ? '-'
    : entries.map(([key, count]) => `${key} ${String(count)}`).join(', ')
}

/** Human-readable summary for stdout: counts and codes only, never record contents. */
export function formatSummary(summary: IngestSummary): string {
  const lines = summary.sources.flatMap((source) => [
    `${source.sourceSystem}: ${String(source.filesRead)} files read`,
    `  records: ${formatCounts(source.records)}`,
    ...(source.records.job > 0
      ? [
          `  jobs by kind: ${formatCounts(source.jobsByKind)}`,
          `  jobs by status: ${formatCounts(source.jobsByStatus)}`,
        ]
      : []),
    `  issues: error ${String(source.issues.error)}, warn ${String(source.issues.warn)}, info ${String(source.issues.info)}`,
    ...(Object.keys(source.issueCodes).length > 0
      ? [`  issue codes: ${formatCounts(source.issueCodes)}`]
      : []),
  ])
  return [
    ...lines,
    summary.unclaimedFiles.length === 0
      ? 'unclaimed files: none'
      : `unclaimed files (${String(summary.unclaimedFiles.length)}): ${summary.unclaimedFiles.join(', ')}`,
    `total: ${String(summary.totals.records)} records, ${String(summary.totals.errors)} errors, ${String(summary.totals.unmappedStatuses)} unmapped statuses`,
  ].join('\n')
}
