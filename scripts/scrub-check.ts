import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { formatHit, loadTerms, runScrub, ScrubConfigError } from '../src/tooling/scrub.ts'

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const termsFile = path.resolve(repoRoot, process.env.SCRUB_TERMS_FILE ?? '_private/scrub_terms.txt')

try {
  const terms = loadTerms(termsFile)
  const hits = runScrub({ repoRoot, terms })
  if (hits.length > 0) {
    hits.forEach((hit) => {
      console.error(formatHit(hit))
    })
    console.error(`scrub: ${String(hits.length)} hit(s)`)
    process.exit(1)
  }
  console.log(`scrub: clean (${String(terms.length)} terms)`)
} catch (error) {
  if (error instanceof ScrubConfigError) {
    console.error(`scrub: ${error.message}`)
    process.exit(2)
  }
  throw error
}
