import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** How many commits back from HEAD to check messages for. */
const COMMIT_DEPTH = 50

export class ScrubConfigError extends Error {}

export interface ScrubHit {
  /** A tracked file path, `branch-name`, or `commit <sha>`. */
  source: string
  /** 1-based line within the source. */
  line: number
  /** 1-based index into the terms list; the term text itself is never reported. */
  termIndex: number
}

export function parseTerms(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

export function loadTerms(file: string): string[] {
  if (!existsSync(file)) {
    throw new ScrubConfigError(`Scrub terms file not found: ${file} (set SCRUB_TERMS_FILE)`)
  }
  const terms = parseTerms(readFileSync(file, 'utf8'))
  if (terms.length === 0) {
    throw new ScrubConfigError(`Scrub terms file has no terms: ${file}`)
  }
  return terms
}

export function scanText(source: string, text: string, terms: string[]): ScrubHit[] {
  const needles = terms.map((term) => term.toLowerCase())
  return text.split(/\r?\n/).flatMap((lineText, lineIndex) => {
    const haystack = lineText.toLowerCase()
    return needles.flatMap((needle, termIndex) =>
      haystack.includes(needle) ? [{ source, line: lineIndex + 1, termIndex: termIndex + 1 }] : [],
    )
  })
}

export function formatHit(hit: ScrubHit): string {
  return `${hit.source}:${String(hit.line)} term #${String(hit.termIndex)}`
}

interface RunScrubOptions {
  repoRoot: string
  terms: string[]
}

export function runScrub({ repoRoot, terms }: RunScrubOptions): ScrubHit[] {
  function git(...args: string[]) {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 << 20 })
  }

  const fileHits = git('ls-files', '-z')
    .split('\0')
    .filter((file) => file !== '')
    .flatMap((file) => {
      const fullPath = path.join(repoRoot, file)
      // Tracked-but-deleted files and submodule entries have nothing to read.
      if (!existsSync(fullPath)) return []
      const content = readFileSync(fullPath)
      if (content.includes(0)) return []
      return scanText(file, content.toString('utf8'), terms)
    })

  const branchHits = scanText('branch-name', git('rev-parse', '--abbrev-ref', 'HEAD').trim(), terms)

  const commitHits = git('log', `-n${String(COMMIT_DEPTH)}`, '--format=%h%x00%B%x1e')
    .split('\x1e')
    .map((entry) => entry.replace(/^\n/, ''))
    .filter((entry) => entry.includes('\0'))
    .flatMap((entry) => {
      const [sha = '', message = ''] = entry.split('\0')
      return scanText(`commit ${sha}`, message.trimEnd(), terms)
    })

  return [...fileHits, ...branchHits, ...commitHits]
}
