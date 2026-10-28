import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Black-box tests for `npm run new-source -- <name> --role <role> [--format json|csv|ics]
// [--crm-pattern <regex>] [--dry-run]`. Each case copies the repo (no .git, no data pack, no
// _private) into a temp dir outside the repo with node_modules symlinked, runs the script there and
// inspects the copy, so the real checkout is never edited.

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..')
const SLOW = 180_000
/** Top-level entries never copied: VCS, installed deps (symlinked instead), local data and private notes. */
const SKIP_TOP = new Set(['.git', 'node_modules', 'data', '_private', 'coverage', 'dist'])
/** The tracked placeholders of data/, copied so the copy matches a fresh clone. */
const DATA_PLACEHOLDERS = ['.gitkeep', 'README.md']
const ROLES = ['crm', 'log', 'calendar', 'profile', 'other'] as const
const EXISTING_SYSTEMS = ['jobber', 'housecall_pro', 'workiz', 'spreadsheet', 'ics', 'profiles']
const BATCH_KEYS = ['calendarBlocks', 'declaredHours', 'issues', 'jobs', 'properties', 'providers']

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
  output: string
}

interface Tree {
  [relPath: string]: string
}

interface Probe {
  traitKeys: string[]
  traits: { role: string; pattern: { source: string; flags: string } | null } | null
  systems: string[]
  patterns: string[]
  fixturePaths: string[]
  unclaimedFixtures: string[]
  emptyParse: Record<string, unknown[]>
  fixtureParse: { counts: Record<string, number>; errorIssues: number }
}

interface VitestAssertion {
  title: string
  fullName: string
  status: string
}

interface VitestReport {
  success: boolean
  testResults: { name: string; assertionResults: VitestAssertion[] }[]
}

const createdDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  createdDirs.push(dir)
  return dir
}

function removeTempDir(dir: string) {
  rmSync(dir, { recursive: true, force: true })
}

/** A copy of the working tree in a fresh temp dir, with node_modules symlinked to the repo's. */
function makeCopy(): string {
  const dir = makeTempDir('new-source-copy-')
  readdirSync(PROJECT_ROOT)
    .filter((entry) => !SKIP_TOP.has(entry))
    .forEach((entry) => {
      cpSync(path.join(PROJECT_ROOT, entry), path.join(dir, entry), { recursive: true })
    })
  mkdirSync(path.join(dir, 'data'))
  DATA_PLACEHOLDERS.filter((name) => existsSync(path.join(PROJECT_ROOT, 'data', name))).forEach(
    (name) => {
      cpSync(path.join(PROJECT_ROOT, 'data', name), path.join(dir, 'data', name))
    },
  )
  symlinkSync(path.join(PROJECT_ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
  return dir
}

/** Every file under `root` except node_modules, as "/"-separated relative path → sha256. */
function snapshot(root: string): Tree {
  const tree: Tree = {}
  function walk(dir: string) {
    readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(dir, entry.name)
      if (dir === root && entry.name === 'node_modules') return
      if (entry.isDirectory()) {
        walk(full)
        return
      }
      const rel = path.relative(root, full).split(path.sep).join('/')
      tree[rel] = createHash('sha256').update(readFileSync(full)).digest('hex')
    })
  }
  walk(root)
  return tree
}

function diffTrees(before: Tree, after: Tree) {
  const added = Object.keys(after)
    .filter((key) => !(key in before))
    .sort()
  const removed = Object.keys(before)
    .filter((key) => !(key in after))
    .sort()
  const changed = Object.keys(after)
    .filter((key) => key in before && before[key] !== after[key])
    .sort()
  return { added, removed, changed }
}

/** The env for child processes, without the parent vitest's markers. */
function childEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('VITEST') && key !== 'NODE_ENV' && key !== 'TEST',
    ),
  )
}

function run(cwd: string, command: string, args: readonly string[]): RunResult {
  const result = spawnSync(command, args, {
    cwd,
    env: childEnv(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}\n${result.stderr}`,
  }
}

function newSource(cwd: string, ...args: string[]): RunResult {
  return run(cwd, 'npm', ['run', 'new-source', '--', ...args])
}

function bin(copy: string, name: string): string {
  return path.join(copy, 'node_modules/.bin', name)
}

/** The script ran (rather than npm failing to find it) and refused with a message naming `subject`. */
function expectRefusal(result: RunResult, subject: string) {
  expect(result.output).not.toMatch(/missing script/i)
  expect(result.status, result.output).not.toBe(0)
  expect(result.status).not.toBeNull()
  expect(result.output).toContain(subject)
}

/** "acme_crm" → "acmeCrm"; a one-word name is used as is. */
function camel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase())
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? listFiles(full) : [full]
  })
}

const PROBE_SOURCE = `
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [root, name] = process.argv.slice(2)
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href)
const types = await load('src/adapters/types.ts')
const { adapters } = await load('src/adapters/registry.ts')
const { matchesPattern } = await load('src/ingest/files.ts')

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  )
const fixtureDir = path.join(root, 'test/fixtures', name)
const files = walk(fixtureDir)
  .sort()
  .map((full) => ({
    path: ['sources', name, ...path.relative(fixtureDir, full).split(path.sep)].join('/'),
    content: readFileSync(full, 'utf8'),
  }))
const ctx = {
  dataPackDir: '/fixture-pack',
  ingestedAt: '2026-11-02T12:34:56Z',
  today: '2026-11-02',
  now: '2026-11-02T06:00:00Z',
  timeZone: 'America/Chicago',
  historyDays: 731,
  horizonDays: 31,
}
const adapter = adapters.find((a) => a.sourceSystem === name)
const traits = Object.hasOwn(types.SOURCE_TRAITS, name) ? types.SOURCE_TRAITS[name] : null
const fixtureBatch = adapter ? adapter.parse(files, ctx) : {}
const counts = Object.fromEntries(
  Object.entries(fixtureBatch).map(([key, value]) => [key, value.length]),
)
console.log(
  JSON.stringify({
    traitKeys: Object.keys(types.SOURCE_TRAITS),
    traits: traits && {
      role: traits.role,
      pattern: traits.declaredCrmPattern && {
        source: traits.declaredCrmPattern.source,
        flags: traits.declaredCrmPattern.flags,
      },
    },
    systems: adapters.map((a) => a.sourceSystem),
    patterns: adapter ? [...adapter.patterns] : [],
    fixturePaths: files.map((f) => f.path),
    unclaimedFixtures: files
      .map((f) => f.path)
      .filter((p) => !(adapter?.patterns ?? []).some((pattern) => matchesPattern(pattern, p))),
    emptyParse: adapter ? adapter.parse([], ctx) : {},
    fixtureParse: {
      counts,
      errorIssues: (fixtureBatch.issues ?? []).filter((i) => i.severity === 'error').length,
    },
  }),
)
`

/** Imports the copy's types and registry and reports what the new source declares. */
function probe(copy: string, name: string): Probe {
  const dir = makeTempDir('new-source-probe-')
  const file = path.join(dir, 'probe.mts')
  writeFileSync(file, PROBE_SOURCE)
  const result = run(copy, bin(copy, 'tsx'), [file, copy, name])
  removeTempDir(dir)
  expect(result.status, result.output).toBe(0)
  return JSON.parse(result.stdout) as Probe
}

function vitestReport(
  copy: string,
  files: readonly string[],
): { result: RunResult; report: VitestReport } {
  const dir = makeTempDir('new-source-report-')
  const outputFile = path.join(dir, 'report.json')
  const result = run(copy, bin(copy, 'vitest'), [
    'run',
    '--project',
    'unit',
    '--reporter=json',
    `--outputFile=${outputFile}`,
    ...files,
  ])
  const report = JSON.parse(readFileSync(outputFile, 'utf8')) as VitestReport
  removeTempDir(dir)
  return { result, report }
}

function assertionsOf(report: VitestReport, fileSuffix: string): VitestAssertion[] {
  const file = report.testResults.find((entry) => entry.name.endsWith(fileSuffix))
  expect(file, `no results for ${fileSuffix}`).toBeDefined()
  return file?.assertionResults ?? []
}

/** The agent prompt from docs/adding-a-source.md with the placeholders filled in. */
function filledPrompt(copy: string, name: string): string {
  const guide = readFileSync(path.join(copy, 'docs/adding-a-source.md'), 'utf8')
  const match = /## Prompt for a coding agent\s+```text\n([\s\S]*?)```/.exec(guide)
  expect(match, 'agent prompt block in docs/adding-a-source.md').not.toBeNull()
  return (match?.[1] ?? '')
    .replaceAll('<camelName>', camel(name))
    .replaceAll('<folder>', name)
    .replaceAll('<name>', name)
    .trim()
}

describe('npm run new-source', () => {
  describe('--dry-run', () => {
    let copy: string
    beforeAll(() => {
      copy = makeCopy()
    })
    afterAll(() => {
      removeTempDir(copy)
    })

    it('prints the planned edits, exits 0 and leaves every file byte-identical', () => {
      const before = snapshot(copy)
      const result = newSource(copy, 'acme_crm', '--role', 'crm', '--format', 'json', '--dry-run')
      expect(result.status, result.output).toBe(0)
      ;[
        'src/adapters/acmeCrm.ts',
        'src/adapters/types.ts',
        'src/adapters/registry.ts',
        'test/unit/adapters/acmeCrm.test.ts',
        'test/fixtures/acme_crm/',
      ].forEach((planned) => {
        expect(result.stdout).toContain(planned)
      })
      expect(snapshot(copy)).toEqual(before)
    })

    it('still refuses an invalid name, changing nothing', () => {
      const before = snapshot(copy)
      expectRefusal(newSource(copy, 'workiz', '--role', 'crm', '--dry-run'), 'workiz')
      expect(snapshot(copy)).toEqual(before)
    })
  })

  describe('a real run (acme_crm, crm, json)', () => {
    const name = 'acme_crm'
    let copy: string
    let before: Tree
    let result: RunResult

    beforeAll(() => {
      copy = makeCopy()
      before = snapshot(copy)
      result = newSource(copy, name, '--role', 'crm', '--format', 'json', '--crm-pattern', 'acme')
    }, SLOW)
    afterAll(() => {
      removeTempDir(copy)
    })

    it('exits 0', () => {
      expect(result.output).not.toMatch(/missing script/i)
      expect(result.status, result.output).toBe(0)
    })

    it('creates the adapter, test and fixtures and edits only types.ts and registry.ts', () => {
      const { added, removed, changed } = diffTrees(before, snapshot(copy))
      expect(removed).toEqual([])
      expect(changed).toEqual(['src/adapters/registry.ts', 'src/adapters/types.ts'])
      const fixtures = added.filter((file) => file.startsWith('test/fixtures/acme_crm/'))
      expect(fixtures.length).toBeGreaterThan(0)
      fixtures.forEach((file) => {
        expect(file.endsWith('.json'), file).toBe(true)
      })
      expect(added.filter((file) => !fixtures.includes(file))).toEqual([
        'src/adapters/acmeCrm.ts',
        'test/unit/adapters/acmeCrm.test.ts',
      ])
    })

    it('only adds lines to types.ts and registry.ts', () => {
      ;['src/adapters/types.ts', 'src/adapters/registry.ts'].forEach((file) => {
        const original = readFileSync(path.join(PROJECT_ROOT, file), 'utf8').split('\n')
        const edited = readFileSync(path.join(copy, file), 'utf8').split('\n')
        const remaining = original.filter((line) => line.trim() !== '')
        // Every original non-blank line survives, in order.
        const unmatched = edited.reduce(
          (left, line) => (left[0] === line ? left.slice(1) : left),
          remaining,
        )
        expect(unmatched, file).toEqual([])
      })
      const types = readFileSync(path.join(copy, 'src/adapters/types.ts'), 'utf8')
      expect(types).toMatch(/\|\s*'acme_crm'/)
      const registry = readFileSync(path.join(copy, 'src/adapters/registry.ts'), 'utf8')
      expect(registry).toContain("import { acmeCrmAdapter } from './acmeCrm.ts'")
      expect(registry).toMatch(/\bacmeCrmAdapter,?\s*\n?\s*\]/)
    })

    it('writes an adapter that builds on shared.ts and marks its mapping stubs TODO', () => {
      const adapter = readFileSync(path.join(copy, 'src/adapters/acmeCrm.ts'), 'utf8')
      expect(adapter).toMatch(/export const acmeCrmAdapter\s*:\s*SourceAdapter/)
      expect(adapter).toContain("from './shared.ts'")
      expect(adapter).toContain('TODO')
    })

    it('registers the adapter with a crm traits entry appended last', () => {
      const info = probe(copy, name)
      expect(info.systems).toHaveLength(7)
      expect(info.systems).toContain(name)
      expect(info.traitKeys).toEqual([...EXISTING_SYSTEMS, name])
      expect(info.traits?.role).toBe('crm')
      expect(info.traits?.pattern?.source).toBe('acme')
      expect(info.traits?.pattern?.flags).toContain('i')
    })

    it('claims data-pack files under sources/acme_crm/, including its own fixtures', () => {
      const info = probe(copy, name)
      expect(info.patterns.length).toBeGreaterThan(0)
      info.patterns.forEach((pattern) => {
        expect(pattern.startsWith('sources/acme_crm/'), pattern).toBe(true)
      })
      expect(info.fixturePaths.length).toBeGreaterThan(0)
      expect(info.unclaimedFixtures).toEqual([])
    })

    it('parses to an empty, valid batch: nothing mapped yet and no errors', () => {
      const info = probe(copy, name)
      expect(Object.keys(info.emptyParse).sort()).toEqual(BATCH_KEYS)
      Object.values(info.emptyParse).forEach((values) => {
        expect(values).toEqual([])
      })
      expect(Object.keys(info.fixtureParse.counts).sort()).toEqual(BATCH_KEYS)
      BATCH_KEYS.filter((key) => key !== 'issues').forEach((key) => {
        expect(info.fixtureParse.counts[key], key).toBe(0)
      })
      expect(info.fixtureParse.errorIssues).toBe(0)
    })

    it(
      'type-checks, and the generated files pass prettier and eslint',
      () => {
        const tsc = run(copy, bin(copy, 'tsc'), ['--noEmit'])
        expect(tsc.status, tsc.output).toBe(0)
        const generated = [
          'src/adapters/acmeCrm.ts',
          'src/adapters/types.ts',
          'src/adapters/registry.ts',
          'test/unit/adapters/acmeCrm.test.ts',
        ]
        const prettier = run(copy, bin(copy, 'prettier'), ['--check', ...generated])
        expect(prettier.status, prettier.output).toBe(0)
        const eslint = run(copy, bin(copy, 'eslint'), generated)
        expect(eslint.status, eslint.output).toBe(0)
      },
      SLOW,
    )

    it(
      'passes the registry contract with 7 adapters, and the new test file passes its contract checks',
      () => {
        const { result: vitest, report } = vitestReport(copy, [
          'test/unit/adapters/registry-contract.test.ts',
          'test/unit/adapters/acmeCrm.test.ts',
        ])
        expect(vitest.status, vitest.output).toBe(0)
        expect(report.success).toBe(true)

        const contract = assertionsOf(report, 'registry-contract.test.ts')
        expect(contract.every((test) => test.status === 'passed')).toBe(true)
        expect(contract.some((test) => test.fullName.includes('acme_crm'))).toBe(true)

        const own = assertionsOf(report, 'acmeCrm.test.ts')
        const first = own.filter((test) => /map your first record/i.test(test.title))
        expect(first).toHaveLength(1)
        const checks = own.filter((test) => !/map your first record/i.test(test.title))
        expect(checks.length).toBeGreaterThan(0)
        checks.forEach((test) => {
          expect(test.status, test.fullName).toBe('passed')
        })
      },
      SLOW,
    )

    it(
      "marks 'map your first record' as the one expected failure, and it really fails",
      () => {
        const file = path.join(copy, 'test/unit/adapters/acmeCrm.test.ts')
        const source = readFileSync(file, 'utf8')
        const marked = source.match(/\b(?:it|test)\.fails\(\s*['"`][^'"`]*map your first record/gi)
        expect(marked).toHaveLength(1)
        expect(source.match(/\.fails\(/g)).toHaveLength(1)

        // Without the marker the test fails: parse() maps nothing yet.
        writeFileSync(file, source.replace(/\b(it|test)\.fails\(/, '$1('))
        const { report } = vitestReport(copy, ['test/unit/adapters/acmeCrm.test.ts'])
        writeFileSync(file, source)
        const first = assertionsOf(report, 'acmeCrm.test.ts').filter((test) =>
          /map your first record/i.test(test.title),
        )
        expect(first.map((test) => test.status)).toEqual(['failed'])
      },
      SLOW,
    )

    it('prints next steps with the filled-in agent prompt', () => {
      const stdout = result.stdout.replaceAll('\r\n', '\n')
      expect(stdout).toContain(filledPrompt(copy, name))
      expect(stdout).not.toMatch(/<(name|camelName|folder)>/)
      expect(stdout).toContain('test/unit/adapters/registry.test.ts')
      expect(stdout).toContain('data/sources/acme_crm/')
    })

    it('refuses to run again with the same name, changing nothing', () => {
      const current = snapshot(copy)
      expectRefusal(newSource(copy, name, '--role', 'crm', '--format', 'json'), name)
      expect(snapshot(copy)).toEqual(current)
    })
  })

  describe('refuses to overwrite existing files', () => {
    it.each([
      ['src/adapters/acmeCrm.ts'],
      ['test/unit/adapters/acmeCrm.test.ts'],
      ['test/fixtures/acme_crm/sample.json'],
    ])('%s', (existing) => {
      const copy = makeCopy()
      try {
        mkdirSync(path.dirname(path.join(copy, existing)), { recursive: true })
        writeFileSync(path.join(copy, existing), '// hand-written, keep\n')
        const before = snapshot(copy)
        const result = newSource(copy, 'acme_crm', '--role', 'crm', '--format', 'json')
        expectRefusal(
          result,
          path.dirname(existing) === 'test/fixtures/acme_crm' ? 'test/fixtures/acme_crm' : existing,
        )
        expect(snapshot(copy)).toEqual(before)
      } finally {
        removeTempDir(copy)
      }
    })
  })

  describe('refuses invalid input with a nonzero exit, changing nothing', () => {
    let copy: string
    let before: Tree
    beforeAll(() => {
      copy = makeCopy()
      before = snapshot(copy)
    })
    afterAll(() => {
      removeTempDir(copy)
    })

    it.each([
      ['CamelCase', 'AcmeCrm'],
      ['a space', 'acme crm'],
      ['a hyphen', 'acme-crm'],
      ['a leading digit', '2acme'],
      ['an existing name', 'workiz'],
      ['another existing name', 'housecall_pro'],
    ])('a name with %s (%s)', (_label, name) => {
      expectRefusal(newSource(copy, name, '--role', 'crm', '--format', 'json'), name)
      expect(snapshot(copy)).toEqual(before)
    })

    it('an unknown --role', () => {
      expectRefusal(newSource(copy, 'acme_crm', '--role', 'vendor'), 'vendor')
      expect(snapshot(copy)).toEqual(before)
    })

    it('a missing --role', () => {
      expectRefusal(newSource(copy, 'acme_crm'), '--role')
      expect(snapshot(copy)).toEqual(before)
    })

    it('an unknown --format', () => {
      expectRefusal(newSource(copy, 'acme_crm', '--role', 'crm', '--format', 'xml'), 'xml')
      expect(snapshot(copy)).toEqual(before)
    })
  })

  describe('each --role yields the documented SOURCE_TRAITS', () => {
    const cases = [
      { role: 'crm', name: 'acme_crm', format: 'json', extra: ['--crm-pattern', 'acme|\\bacm\\b'] },
      { role: 'log', name: 'beta_log', format: 'csv', extra: [] },
      { role: 'calendar', name: 'gamma_cal', format: 'ics', extra: [] },
      { role: 'profile', name: 'delta_profiles', format: 'json', extra: [] },
      { role: 'other', name: 'zeta', format: 'csv', extra: [] },
    ] as const

    it('covers every SourceRole', () => {
      expect(cases.map((entry) => entry.role)).toEqual([...ROLES])
    })

    it.each(cases)(
      '$role ($name, $format)',
      ({ role, name, format, extra }) => {
        const copy = makeCopy()
        try {
          const result = newSource(copy, name, '--role', role, '--format', format, ...extra)
          expect(result.output).not.toMatch(/missing script/i)
          expect(result.status, result.output).toBe(0)

          const info = probe(copy, name)
          expect(info.systems).toContain(name)
          expect(info.traitKeys.at(-1)).toBe(name)
          expect(info.traits?.role).toBe(role)
          if (role === 'crm') {
            expect(info.traits?.pattern?.source).toBe('acme|\\bacm\\b')
            expect(info.traits?.pattern?.flags).toContain('i')
          } else {
            expect(info.traits?.pattern).toBeNull()
          }

          const fixtures = listFiles(path.join(copy, 'test/fixtures', name))
          expect(fixtures.length).toBeGreaterThan(0)
          fixtures.forEach((file) => {
            expect(path.extname(file), file).toBe(`.${format}`)
          })
          expect(info.unclaimedFixtures).toEqual([])
          if (format === 'ics') {
            fixtures.forEach((file) => {
              expect(readFileSync(file, 'utf8')).toMatch(/^BEGIN:VCALENDAR/)
            })
          }
          if (format === 'json') {
            fixtures.forEach((file) => {
              expect(() => JSON.parse(readFileSync(file, 'utf8')) as unknown).not.toThrow()
            })
          }
          expect(existsSync(path.join(copy, 'src/adapters', `${camel(name)}.ts`))).toBe(true)
          expect(existsSync(path.join(copy, 'test/unit/adapters', `${camel(name)}.test.ts`))).toBe(
            true,
          )
        } finally {
          removeTempDir(copy)
        }
      },
      SLOW,
    )
  })

  describe('temp copies', () => {
    it('live outside the repo and are all removed', () => {
      expect(createdDirs.length).toBeGreaterThan(0)
      createdDirs.forEach((dir) => {
        expect(path.relative(PROJECT_ROOT, dir).startsWith('..'), dir).toBe(true)
        expect(existsSync(dir), dir).toBe(false)
      })
    })
  })
})
