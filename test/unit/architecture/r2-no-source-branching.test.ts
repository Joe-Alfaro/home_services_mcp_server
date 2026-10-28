/*
 * R2 (b): adapters are registered in one list, and nothing in the core modules imports a specific
 * adapter or branches on a specific source system, so a new source is added without touching core
 * logic.
 *
 * The done check's grep (`sourceSystem ===`, 'jobber', 'workiz', 'housecall_pro' in normalize,
 * resolve, availability and mcp) is both too narrow and too broad, so this pins a stricter rule:
 *
 * - Scope: src/normalize, src/resolve, src/ingest, src/availability, src/db and src/mcp. The task
 *   brief adds src/ingest and src/db to the grep's four directories; src/ingest/pipeline.ts may
 *   import the registry list (that is the registration wiring R2 asks for).
 * - Every source system counts ('spreadsheet', 'ics' and 'profiles' too, not just the three CRMs),
 *   taken from the SOURCE_TRAITS keys so a new source is covered automatically.
 * - Any source-system string literal in a value position is a hit: `===`/`!==` comparisons, `case`
 *   labels, Sets, tuples, `.includes()` arguments, and a quoted system inside SQL text. Comparing
 *   through a lookup set is the same branch as comparing directly.
 * - Type positions are exempt ("outside type definitions"): `type X = 'jobber' | ...`, `as`
 *   casts and annotations never change behaviour.
 * - `sourceSystem === 'x'` where 'x' is not a literal (for example a `typeof` check in
 *   src/mcp/privacy.ts) is not a hit: it does not name a source.
 *
 * Whatever a source needs from the core (a role such as "profile" or "CRM", a name pattern for a
 * declared CRM, a duplicate-row rule) must come from the adapter contract, not from a name check.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { adapters } from '../../../src/adapters/registry.ts'
import { SOURCE_TRAITS } from '../../../src/adapters/types.ts'
import { REPO_ROOT } from '../../../src/config.ts'

const SRC = path.join(REPO_ROOT, 'src')
const CORE_DIRS = ['normalize', 'resolve', 'ingest', 'availability', 'db', 'mcp'] as const
const SOURCE_SYSTEMS: readonly string[] = Object.keys(SOURCE_TRAITS)
/** The six sources this rule was first written for; the scan must never drop one of them. */
const ORIGINAL_SYSTEMS = ['housecall_pro', 'ics', 'jobber', 'profiles', 'spreadsheet', 'workiz']

/** The only adapter modules a core module may import, and who may import them. */
const ALLOWED_ADAPTER_IMPORTS: Readonly<Record<string, (importer: string) => boolean>> = {
  'src/adapters/types.ts': () => true,
  'src/adapters/registry.ts': (importer) => importer === 'src/ingest/pipeline.ts',
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return full.endsWith('.ts') ? [full] : []
  })
}

function inTypePosition(node: ts.Node): boolean {
  for (let current = node.parent; !ts.isSourceFile(current); current = current.parent) {
    if (ts.isTypeNode(current)) return true
    if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) return true
  }
  return false
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
}

/** Source-system literals in value positions, as "file:line  code" (one entry per literal). */
function sourceBranches(text: string, file: string, systems = SOURCE_SYSTEMS): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const lines = text.split('\n')
  const quoted = new RegExp(`'(${systems.join('|')})'`)
  const hits: string[] = []

  const visit = (node: ts.Node): void => {
    const literalText =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        ? node.text
        : ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
          ? node.text
          : undefined
    if (literalText !== undefined && !inTypePosition(node)) {
      if (systems.includes(literalText) || quoted.test(literalText)) {
        const line = lineOf(source, node)
        hits.push(`${file}:${String(line)}  ${(lines[line - 1] ?? '').trim()}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return hits
}

/** Imports of src/adapters/* that the allow-list does not permit, as "file:line  code". */
function forbiddenAdapterImports(text: string, file: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  return source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) return []
    const specifier = statement.moduleSpecifier
    if (specifier === undefined || !ts.isStringLiteral(specifier)) return []
    if (!specifier.text.startsWith('.')) return []
    const target = path
      .relative(REPO_ROOT, path.resolve(REPO_ROOT, path.dirname(file), specifier.text))
      .split(path.sep)
      .join('/')
    if (!target.startsWith('src/adapters/')) return []
    if (ALLOWED_ADAPTER_IMPORTS[target]?.(file) === true) return []
    return [`${file}:${String(lineOf(source, statement))}  ${statement.getText(source)}`]
  })
}

function coreFiles(dir: string): { file: string; text: string }[] {
  return sourceFiles(path.join(SRC, dir)).map((full) => ({
    file: path.relative(REPO_ROOT, full).split(path.sep).join('/'),
    text: readFileSync(full, 'utf8'),
  }))
}

describe('R2(b): the branch detector', () => {
  const systems = ['jobber', 'profiles', 'ics']

  it.each([
    ['a === comparison', `if (ref.sourceSystem === 'profiles') run()`],
    ['a !== comparison', `const named = xs.filter((x) => x.ref.sourceSystem !== 'ics')`],
    ['a switch case', `switch (system) { case 'jobber': break }`],
    ['a lookup set', `const NON_CRM = new Set(['ics'])`],
    ['a tuple list', `const CRMS = [['jobber', /jobber/i]]`],
    ['an includes argument', `if (['jobber'].includes(system)) run()`],
    ['SQL text', "const sql = `SELECT 1 FROM source_records WHERE source_system = 'profiles'`"],
  ])('R2(b): flags %s', (_name, code) => {
    expect(sourceBranches(code, 'src/x.ts', systems)).toHaveLength(1)
  })

  it.each([
    ['a type alias', `type System = 'jobber' | 'profiles'`],
    ['an interface field', `interface X { system: 'ics' }`],
    ['an as cast', `const s = value as 'jobber'`],
    ['a typeof check', `const ok = typeof value.sourceSystem === 'string'`],
    ['an unrelated word', `const label = 'jobber-ish'`],
    ['an import path', `import { x } from './profiles.ts'`],
  ])('R2(b): ignores %s', (_name, code) => {
    expect(sourceBranches(code, 'src/x.ts', systems)).toEqual([])
  })

  it('R2(b): names the file and line of each hit', () => {
    const code = ['const a = 1', `if (s === 'jobber') run()`].join('\n')
    expect(sourceBranches(code, 'src/resolve/x.ts', systems)).toEqual([
      `src/resolve/x.ts:2  if (s === 'jobber') run()`,
    ])
  })
})

describe('R2(b): core modules never name a specific source system', () => {
  it('R2(b): the scan looks for every SOURCE_TRAITS key, including the six original systems', () => {
    expect(SOURCE_SYSTEMS).toEqual(expect.arrayContaining(ORIGINAL_SYSTEMS))
  })

  it('R2(b): every registered adapter is a system the scan looks for', () => {
    const registered = adapters.map((adapter) => adapter.sourceSystem)
    expect(SOURCE_SYSTEMS).toEqual(expect.arrayContaining(registered))
  })

  it.each(CORE_DIRS)('R2(b): src/%s has no branch on a source-system literal', (dir) => {
    const hits = coreFiles(dir).flatMap(({ file, text }) => sourceBranches(text, file))
    expect(hits, `source-specific branches in src/${dir}:\n${hits.join('\n')}`).toEqual([])
  })

  it.each(CORE_DIRS)('R2(b): src/%s imports no specific adapter', (dir) => {
    const hits = coreFiles(dir).flatMap(({ file, text }) => forbiddenAdapterImports(text, file))
    expect(hits, `adapter imports in src/${dir}:\n${hits.join('\n')}`).toEqual([])
  })
})
