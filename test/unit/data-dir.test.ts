import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..')
// Built from parts so this file does not match its own search.
const OLD_DEFAULT = ['_private', 'data_pack'].join('/')

function isIgnored(file: string): boolean {
  // --no-index tests the ignore rules even for files that are already tracked.
  const result = spawnSync('git', ['check-ignore', '-q', '--no-index', file], {
    cwd: PROJECT_ROOT,
  })
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore failed for ${file}: ${String(result.stderr)}`)
  }
  return result.status === 0
}

function tracked(...pathspecs: string[]): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => file !== '')
}

describe('data/ folder', () => {
  it('has .gitignore rules that ignore the pack but keep the placeholder files', () => {
    const lines = readFileSync(path.join(PROJECT_ROOT, '.gitignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
    expect(lines).toContain('data/*')
    expect(lines).toContain('!data/.gitkeep')
    expect(lines).toContain('!data/README.md')
    expect(lines.some((line) => line.includes('_private'))).toBe(false)
  })

  it('ignores pack files under data/', () => {
    expect(isIgnored('data/sources/x.json')).toBe(true)
    expect(isIgnored('data/reference/street_segments.csv')).toBe(true)
  })

  it('does not ignore data/.gitkeep or data/README.md', () => {
    expect(isIgnored('data/.gitkeep')).toBe(false)
    expect(isIgnored('data/README.md')).toBe(false)
  })

  it('tracks data/.gitkeep', () => {
    expect(tracked('data/.gitkeep')).toEqual(['data/.gitkeep'])
  })
})

describe('old data pack default', () => {
  it('is not referenced by code, tests or current docs', () => {
    const files = tracked(
      'src/',
      'scripts/',
      'test/',
      'README.md',
      'docs/data-model.md',
      'ARCHITECTURE.md',
    )
    expect(files.length).toBeGreaterThan(0)
    const offenders = files.filter((file) =>
      readFileSync(path.join(PROJECT_ROOT, file), 'utf8').includes(OLD_DEFAULT),
    )
    expect(offenders).toEqual([])
  })
})
