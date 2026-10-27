import { providerRef, type Job } from './db.ts'
import { safeText } from './privacy.ts'
import { presentOptional } from './time.ts'

/**
 * A job, visit or estimate as an agent sees it: provider, what, when (local offsets), where as
 * hundred block + zip only (R17 c), and its citations (R19).
 */
export function presentJob(job: Job, allowedHouseNumbers: readonly string[] = []) {
  return {
    provider: providerRef({ id: job.providerId, name: job.providerName }),
    kind: job.kind,
    status: job.status,
    trade: job.trade,
    service: job.service,
    description: safeText(job.description, allowedHouseNumbers),
    start: presentOptional(job.startAt),
    end: presentOptional(job.endAt),
    ...(job.completedAt === null ? {} : { completedAt: presentOptional(job.completedAt) }),
    ...(job.allDay ? { allDay: true } : {}),
    // G9: the old slot is gone (it never blocks); the date it moved from is evidence only.
    rescheduledFrom: job.rescheduledFrom,
    block: job.blockLabel,
    zip: job.zip,
    ...(job.duplicateCount > 1 ? { duplicateSourceRows: job.duplicateCount } : {}),
    confidence: job.confidence,
    sources: job.sources,
  }
}
