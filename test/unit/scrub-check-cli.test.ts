import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..')
const SCRIPT = path.join(PROJECT_ROOT, 'scripts/scrub-check.ts')
const TSX = path.join(PROJECT_ROOT, 'node_modules/.bin/tsx')
const SKIP_NOTICE = 'scrub check skipped: no terms file (maintainer-only check)'

// Invented terms; the tracked fixture files below deliberately contain them.
const TERMS = ['zorblaxcorp', 'Quindle Institute']

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

function expectNoTermPrinted(result: RunResult) {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase()
  TERMS.forEach((term) => {
    expect(output).not.toContain(term.toLowerCase())
  })
}

describe('scrub-check script', () => {
  let repo: string
  let outside: string

  function git(...args: string[]) {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  }

  function commit(message: string) {
    git('add', '-A')
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message)
  }

  /** Runs the real script in the temp repo; SCRUB_TERMS_FILE is set only when given. */
  function runCheck(termsFile?: string): RunResult {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key !== 'SCRUB_TERMS_FILE' && !key.startsWith('GIT_'),
      ),
    )
    if (termsFile !== undefined) env.SCRUB_TERMS_FILE = termsFile
    const result = spawnSync(TSX, [SCRIPT], { cwd: repo, env, encoding: 'utf8' })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  function writeDefaultTerms(content: string) {
    mkdirSync(path.join(repo, '_private'), { recursive: true })
    writeFileSync(path.join(repo, '_private/scrub_terms.txt'), content)
  }

  function addTrackedHit() {
    writeFileSync(path.join(repo, 'notes.md'), 'line one\nbuilt for Zorblaxcorp\n')
    commit('docs: add notes')
  }

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'scrub-cli-repo-'))
    outside = mkdtempSync(path.join(tmpdir(), 'scrub-cli-terms-'))
    git('init', '-q', '-b', 'main')
    // Keep the default terms location out of the scanned file set, as in the real repo.
    writeFileSync(path.join(repo, '.gitignore'), '_private/\n')
    writeFileSync(path.join(repo, 'clean.md'), 'a home-services marketplace\n')
    commit('chore: init')
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  describe('no env var and no default terms file (fresh clone)', () => {
    it('skips with one clear notice on stderr and exits 0', () => {
      const result = runCheck()
      expect(result.status).toBe(0)
      expect(result.stderr.trim()).toBe(SKIP_NOTICE)
    })

    it('skips even when tracked content would have been a hit, and prints no term', () => {
      addTrackedHit()
      const result = runCheck()
      expect(result.status).toBe(0)
      expect(result.stderr.trim()).toBe(SKIP_NOTICE)
      expect(result.stdout).not.toContain('notes.md')
      expectNoTermPrinted(result)
    })
  })

  describe('SCRUB_TERMS_FILE set but missing', () => {
    it('hard-fails with exit 2 and does not print the skip notice', () => {
      const result = runCheck(path.join(outside, 'missing.txt'))
      expect(result.status).toBe(2)
      expect(result.stderr).not.toContain(SKIP_NOTICE)
    })

    it('hard-fails even when the default terms file exists', () => {
      writeDefaultTerms(`${TERMS.join('\n')}\n`)
      const result = runCheck(path.join(outside, 'missing.txt'))
      expect(result.status).toBe(2)
      expectNoTermPrinted(result)
    })
  })

  describe('terms file present but empty or blank-only', () => {
    it('fails with exit 2 for an empty default file', () => {
      writeDefaultTerms('')
      const result = runCheck()
      expect(result.status).toBe(2)
      expect(result.stderr).not.toContain(SKIP_NOTICE)
    })

    it('fails with exit 2 for a blank-only default file', () => {
      writeDefaultTerms('# comment only\n\n   \n')
      expect(runCheck().status).toBe(2)
    })

    it('fails with exit 2 for a blank-only file named by SCRUB_TERMS_FILE', () => {
      const file = path.join(outside, 'terms.txt')
      writeFileSync(file, '\n\t\n')
      expect(runCheck(file).status).toBe(2)
    })
  })

  describe('terms file present with a hit', () => {
    it('exits 1 via the default file, printing file:line and term index only', () => {
      writeDefaultTerms(`${TERMS.join('\n')}\n`)
      addTrackedHit()
      const result = runCheck()
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('notes.md:2 term #1')
      expectNoTermPrinted(result)
    })

    it('exits 1 via SCRUB_TERMS_FILE, printing file:line and term index only', () => {
      const file = path.join(outside, 'terms.txt')
      writeFileSync(file, `${TERMS.join('\n')}\n`)
      addTrackedHit()
      const result = runCheck(file)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('notes.md:2 term #1')
      expectNoTermPrinted(result)
    })
  })

  describe('terms file present and clean', () => {
    it('exits 0 via the default file without the skip notice', () => {
      writeDefaultTerms(`${TERMS.join('\n')}\n`)
      const result = runCheck()
      expect(result.status).toBe(0)
      expect(result.stderr).not.toContain(SKIP_NOTICE)
      expectNoTermPrinted(result)
    })

    it('exits 0 via SCRUB_TERMS_FILE without the skip notice', () => {
      const file = path.join(outside, 'terms.txt')
      writeFileSync(file, `${TERMS.join('\n')}\n`)
      const result = runCheck(file)
      expect(result.status).toBe(0)
      expect(result.stderr).not.toContain(SKIP_NOTICE)
    })
  })
})

describe('pre-push hook', () => {
  it('runs the same scrub script through npm run check, with no terms-file override', () => {
    const hook = readFileSync(path.join(PROJECT_ROOT, '.husky/pre-push'), 'utf8')
    const pkg = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(hook).toMatch(/\bnpm run (check|scrub)\b/)
    expect(hook).not.toContain('SCRUB_TERMS_FILE')
    expect(pkg.scripts.check).toContain('npm run scrub')
    expect(pkg.scripts.scrub).toBe('tsx scripts/scrub-check.ts')
  })
})
