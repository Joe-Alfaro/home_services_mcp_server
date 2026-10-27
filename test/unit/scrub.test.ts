import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  formatHit,
  loadTerms,
  parseTerms,
  runScrub,
  scanText,
  ScrubConfigError,
} from '../../src/tooling/scrub.ts'

const TERMS = ['acmecorp', 'Widget Academy']

describe('parseTerms', () => {
  it('drops blank lines and # comments and trims', () => {
    expect(parseTerms('# header\n\n  acmecorp  \n\t\nWidget Academy\n')).toEqual(TERMS)
  })
})

describe('loadTerms', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'scrub-terms-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('fails when the file is missing', () => {
    expect(() => loadTerms(path.join(dir, 'nope.txt'))).toThrow(ScrubConfigError)
  })

  it('fails when the file has no non-blank terms', () => {
    const file = path.join(dir, 'terms.txt')
    writeFileSync(file, '# only a comment\n\n   \n')
    expect(() => loadTerms(file)).toThrow(ScrubConfigError)
  })

  it('returns the terms', () => {
    const file = path.join(dir, 'terms.txt')
    writeFileSync(file, 'acmecorp\nWidget Academy\n')
    expect(loadTerms(file)).toEqual(TERMS)
  })
})

describe('scanText', () => {
  it('reports source, 1-based line and 1-based term index, case-insensitively', () => {
    const text = 'clean line\nBuilt for ACMECORP\nwidget academy and AcmeCorp'
    expect(scanText('a.md', text, TERMS)).toEqual([
      { source: 'a.md', line: 2, termIndex: 1 },
      { source: 'a.md', line: 3, termIndex: 1 },
      { source: 'a.md', line: 3, termIndex: 2 },
    ])
  })

  it('returns nothing for clean text', () => {
    expect(scanText('a.md', 'a home-services marketplace', TERMS)).toEqual([])
  })
})

describe('formatHit', () => {
  it('prints location and term index but never the term text', () => {
    const line = formatHit({ source: 'src/x.ts', line: 7, termIndex: 2 })
    expect(line).toBe('src/x.ts:7 term #2')
    TERMS.forEach((term) => {
      expect(line.toLowerCase()).not.toContain(term.toLowerCase())
    })
  })
})

describe('runScrub', () => {
  let repo: string

  function git(...args: string[]) {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  }

  function commit(message: string) {
    git('add', '-A')
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message)
  }

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'scrub-repo-'))
    git('init', '-q', '-b', 'main')
    writeFileSync(path.join(repo, 'clean.md'), 'a home-services marketplace\n')
    commit('chore: init')
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('passes a clean repository', () => {
    expect(runScrub({ repoRoot: repo, terms: TERMS })).toEqual([])
  })

  it('flags tracked files but ignores untracked ones', () => {
    writeFileSync(path.join(repo, 'tracked.md'), 'line one\nmade for acmecorp\n')
    commit('docs: add file')
    writeFileSync(path.join(repo, 'untracked.md'), 'acmecorp\n')

    expect(runScrub({ repoRoot: repo, terms: TERMS })).toEqual([
      { source: 'tracked.md', line: 2, termIndex: 1 },
    ])
  })

  it('skips binary files', () => {
    writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, ...Buffer.from('acmecorp')]))
    commit('chore: add blob')
    expect(runScrub({ repoRoot: repo, terms: TERMS })).toEqual([])
  })

  it('flags the branch name', () => {
    git('checkout', '-q', '-b', 'feature/acmecorp-thing')
    expect(runScrub({ repoRoot: repo, terms: TERMS })).toEqual([
      { source: 'branch-name', line: 1, termIndex: 1 },
    ])
  })

  it('flags recent commit messages', () => {
    writeFileSync(path.join(repo, 'clean.md'), 'still clean\n')
    commit('feat: thing\n\nFor the Widget Academy folks')
    const hits = runScrub({ repoRoot: repo, terms: TERMS })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ line: 3, termIndex: 2 })
    expect(hits[0]?.source).toMatch(/^commit [0-9a-f]{7,}$/)
  })
})
