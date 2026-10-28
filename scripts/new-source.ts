// Scaffolds a new data source (docs/adding-a-source.md):
//
//   npm run new-source -- <name> --role <crm|log|calendar|profile|other>
//     [--format json|csv|ics] [--crm-pattern <regex>] [--dry-run] [--skip-checks]
//
// Creates src/adapters/<camelName>.ts, test/unit/adapters/<camelName>.test.ts and an invented
// fixture under test/fixtures/<name>/, and adds the name to the SourceSystem union, SOURCE_TRAITS
// and the registry. The edits are located through the TypeScript AST (ts-morph), never by regex.
// It refuses a registered name or any existing target file, never edits a test, and with
// --dry-run only prints the plan.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import * as prettier from 'prettier'
import { Node, Project, type SourceFile } from 'ts-morph'

const ROOT = path.resolve(import.meta.dirname, '..')
const ROLES = ['crm', 'log', 'calendar', 'profile', 'other'] as const
const FORMATS = ['json', 'csv', 'ics'] as const
const NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/
const TYPES_FILE = 'src/adapters/types.ts'
const REGISTRY_FILE = 'src/adapters/registry.ts'
const REGISTRY_TEST = 'test/unit/adapters/registry.test.ts'
const GUIDE = 'docs/adding-a-source.md'

type Role = (typeof ROLES)[number]
type Format = (typeof FORMATS)[number]

interface Options {
  name: string
  camelName: string
  role: Role
  format: Format
  /** The SOURCE_TRAITS declaredCrmPattern as a regex literal, or "null". */
  crmPattern: string
  dryRun: boolean
  skipChecks: boolean
}

interface PlannedFile {
  path: string
  action: 'create' | 'edit'
  content: string
}

/** A refusal: printed without a stack trace, exits nonzero, nothing written. */
class Refusal extends Error {}

const ROLE_LABEL: Record<Role, string> = {
  crm: 'CRM',
  log: 'job log',
  calendar: 'calendar',
  profile: 'provider profiles',
  other: 'other source',
}

const ROLE_TARGET: Record<Role, { key: string; type: string; hint: string }> = {
  crm: {
    key: 'jobs',
    type: 'JobCandidate',
    hint: 'a ProviderCandidate per account, a PropertyCandidate (with ContactPii) per service address and a JobCandidate per job or estimate. See workiz.ts.',
  },
  log: {
    key: 'jobs',
    type: 'JobCandidate',
    hint: 'a ProviderCandidate per log, a PropertyCandidate per address and a JobCandidate per row (date-only rows cover their local day). See spreadsheet.ts.',
  },
  calendar: {
    key: 'calendarBlocks',
    type: 'CalendarBlockCandidate',
    hint: 'a CalendarBlockCandidate per occurrence (busy, category, recurrence), with sourceRecordId "<UID>@<occurrence start>". See ics.ts.',
  },
  profile: {
    key: 'providers',
    type: 'ProviderCandidate',
    hint: 'a ProviderCandidate per profile and a DeclaredHoursCandidate for its hours. See profiles.ts.',
  },
  other: {
    key: 'candidates',
    type: 'candidate',
    hint: 'whatever candidates the source holds. See profiles.ts and workiz.ts.',
  },
}

function camelCase(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase())
}

function parseOptions(argv: readonly string[]): Options {
  const { values, positionals } = (() => {
    try {
      return parseArgs({
        args: [...argv],
        allowPositionals: true,
        options: {
          role: { type: 'string' },
          format: { type: 'string', default: 'json' },
          'crm-pattern': { type: 'string' },
          'dry-run': { type: 'boolean', default: false },
          'skip-checks': { type: 'boolean', default: false },
        },
      })
    } catch (error) {
      throw new Refusal(error instanceof Error ? error.message : String(error))
    }
  })()
  if (positionals.length !== 1) {
    throw new Refusal(
      positionals.length === 0
        ? 'missing <name>'
        : `expected one name, got ${positionals.map((value) => `"${value}"`).join(' ')}`,
    )
  }
  const name = positionals[0] ?? ''
  if (!NAME.test(name)) {
    throw new Refusal(
      `invalid name "${name}": use snake_case (lower-case letters, digits and single underscores, starting with a letter), e.g. acme_crm`,
    )
  }
  const role = values.role
  if (role === undefined) throw new Refusal(`missing --role (one of ${ROLES.join(', ')})`)
  if (!isOneOf(ROLES, role)) {
    throw new Refusal(`unknown --role "${role}" (one of ${ROLES.join(', ')})`)
  }
  const format = values.format
  if (!isOneOf(FORMATS, format)) {
    throw new Refusal(`unknown --format "${format}" (one of ${FORMATS.join(', ')})`)
  }
  return {
    name,
    camelName: camelCase(name),
    role,
    format,
    crmPattern: crmPatternLiteral(role, name, values['crm-pattern']),
    dryRun: values['dry-run'],
    skipChecks: values['skip-checks'],
  }
}

function isOneOf<T extends string>(allowed: readonly T[], value: string): value is T {
  return (allowed as readonly string[]).includes(value)
}

/** A case-insensitive regex literal for a CRM; by default the name with any separator. */
function crmPatternLiteral(role: Role, name: string, given: string | undefined): string {
  if (role !== 'crm') {
    if (given !== undefined) throw new Refusal(`--crm-pattern is only for --role crm, not ${role}`)
    return 'null'
  }
  const source = given ?? name.split('_').join('[ _-]?')
  try {
    // RegExp#toString escapes "/" and line breaks, so the result is a valid literal.
    return String(new RegExp(source, 'i'))
  } catch {
    throw new Refusal(`invalid --crm-pattern "${source}": not a regular expression`)
  }
}

// --- edits to existing files, located through the AST ---------------------------------------

function loadSource(project: Project, relPath: string): SourceFile {
  return project.createSourceFile(relPath, readFileSync(path.join(ROOT, relPath), 'utf8'))
}

function anchorError(file: string, what: string): Refusal {
  return new Refusal(
    `could not find ${what} in ${file}; it changed shape, so add the source by hand (${GUIDE})`,
  )
}

/** The string literals of the SourceSystem union. */
function unionMembers(types: SourceFile): string[] {
  const node = types.getTypeAlias('SourceSystem')?.getTypeNode()
  if (!Node.isUnionTypeNode(node)) throw anchorError(TYPES_FILE, 'the SourceSystem union')
  return node.getTypeNodes().map((member) => {
    const literal = Node.isLiteralTypeNode(member) ? member.getLiteral() : undefined
    if (!Node.isStringLiteral(literal)) throw anchorError(TYPES_FILE, 'string-literal members')
    return literal.getLiteralValue()
  })
}

function traitsObject(types: SourceFile) {
  const initializer = types.getVariableDeclaration('SOURCE_TRAITS')?.getInitializer()
  if (!Node.isObjectLiteralExpression(initializer)) {
    throw anchorError(TYPES_FILE, 'the SOURCE_TRAITS object')
  }
  return initializer
}

function adaptersArray(registry: SourceFile) {
  const initializer = registry.getVariableDeclaration('adapters')?.getInitializer()
  if (!Node.isArrayLiteralExpression(initializer)) {
    throw anchorError(REGISTRY_FILE, 'the adapters array')
  }
  return initializer
}

/** Refuses a name the union, SOURCE_TRAITS or registry already knows. */
function refuseRegistered(options: Options, types: SourceFile, registry: SourceFile) {
  const { name } = options
  if (unionMembers(types).includes(name)) {
    throw new Refusal(`"${name}" is already a SourceSystem in ${TYPES_FILE}`)
  }
  const traitKeys = traitsObject(types)
    .getProperties()
    .map((property) => (Node.isPropertyAssignment(property) ? property.getName() : ''))
  if (traitKeys.includes(name) || traitKeys.includes(`'${name}'`)) {
    throw new Refusal(`"${name}" already has a SOURCE_TRAITS entry in ${TYPES_FILE}`)
  }
  const identifier = `${options.camelName}Adapter`
  const listed = adaptersArray(registry)
    .getElements()
    .some((element) => element.getText() === identifier)
  const imported = registry
    .getImportDeclarations()
    .some((declaration) =>
      declaration.getNamedImports().some((named) => named.getName() === identifier),
    )
  if (listed || imported) {
    throw new Refusal(`${identifier} for "${name}" is already in ${REGISTRY_FILE}`)
  }
}

function editTypes(options: Options, types: SourceFile): string {
  const alias = types.getTypeAliasOrThrow('SourceSystem')
  // Insert after the last member's trailing comment, i.e. at the end of the alias's last line.
  const text = types.getFullText()
  const lineEnd = text.indexOf('\n', alias.getEnd())
  types.insertText(
    lineEnd === -1 ? text.length : lineEnd,
    `\n  | '${options.name}' // ${ROLE_LABEL[options.role]}`,
  )
  // Appended last: declared CRMs are reported in SOURCE_TRAITS order.
  traitsObject(types).addPropertyAssignment({
    name: options.name,
    initializer: `{ role: '${options.role}', declaredCrmPattern: ${options.crmPattern} }`,
  })
  return types.getFullText()
}

function editRegistry(options: Options, registry: SourceFile): string {
  const specifier = `./${options.camelName}.ts`
  const identifier = `${options.camelName}Adapter`
  // Keep the imports sorted by module path, as they are now.
  const imports = registry.getImportDeclarations()
  const index = imports.findIndex(
    (declaration) => declaration.getModuleSpecifierValue() > specifier,
  )
  registry.insertImportDeclaration(index === -1 ? imports.length : index, {
    namedImports: [identifier],
    moduleSpecifier: specifier,
  })
  adaptersArray(registry).addElement(identifier)
  return registry.getFullText()
}

// --- generated files ------------------------------------------------------------------------

interface Fixture {
  /** Relative to test/fixtures/<name>/, laid out as below data/sources/<name>/. */
  file: string
  content: string
  /** Invented personal values in the fixture, checked against issue messages. */
  pii: string[]
}

function fixtureFor(options: Options): Fixture {
  if (options.format === 'ics') {
    return {
      file: 'sample_account/calendar.ics',
      pii: ['Pat Example', '100 Sample St'],
      content: [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Invented//Sample Calendar//EN',
        'BEGIN:VEVENT',
        'UID:sample-1001@example.com',
        'DTSTART;TZID=America/Chicago:20261103T090000',
        'DTEND;TZID=America/Chicago:20261103T110000',
        'SUMMARY:Job - Pat Example - faucet repair',
        'LOCATION:100 Sample St\\, Dallas\\, TX 75201',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:sample-1002@example.com',
        'DTSTART;VALUE=DATE:20261105',
        'DTEND;VALUE=DATE:20261106',
        'SUMMARY:Out of office',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n'),
    }
  }
  if (options.format === 'csv') {
    return {
      file: 'sample_account/job_log.csv',
      pii: ['Pat Example', '555-0101', '100 Sample St'],
      content: [
        'Date,Time,Customer,Phone,Address,Job,Status,Notes',
        '11/3/2026,9:00 AM,Pat Example,555-0101,"100 Sample St, Dallas, TX 75201",Faucet repair,Scheduled,Gate code 1234',
        '11/4/2026,,Sam Sample,555-0102,"200 Invented Ave, Dallas, TX 75202",Drywall patch,Done,',
        '',
      ].join('\n'),
    }
  }
  if (options.role === 'profile') {
    return {
      file: 'sample_account/profiles.json',
      pii: [],
      content: JSON.stringify({
        records: [
          {
            id: 'P-1001',
            business_name: 'Sample Handyman Co',
            phone: '555-0100',
            email: 'office@example.com',
            trades: ['handyman'],
            hours: 'Mon-Fri 8am-5pm',
            service_zips: ['75201', '75202'],
          },
        ],
      }),
    }
  }
  return {
    file: 'sample_account/records.json',
    pii: ['Pat Example', '555-0101', 'pat@example.com', '100 Sample St'],
    content: JSON.stringify({
      records: [
        {
          id: 'J-1001',
          status: 'scheduled',
          start: '2026-11-03 09:00',
          end: '2026-11-03 11:00',
          title: 'Faucet repair',
          customer: { name: 'Pat Example', phone: '555-0101', email: 'pat@example.com' },
          address: { street: '100 Sample St', city: 'Dallas', state: 'TX', zip: '75201' },
        },
        {
          id: 'J-1002',
          status: 'completed',
          start: '2026-11-01 01:30',
          end: null,
          title: 'Drywall patch',
          customer: { name: 'Sam Sample', phone: '555-0102', email: 'sam@example.com' },
          address: { street: '200 Invented Ave', city: 'Dallas', state: 'TX', zip: '75202' },
        },
      ],
    }),
  }
}

/** `text` as "// " line comments wrapped at Prettier's print width (it never wraps comments). */
function lineComment(text: string, width = 100): string {
  const lines = text.split(' ').reduce<string[]>((done, word) => {
    const last = done.at(-1)
    if (last !== undefined && `${last} ${word}`.length <= width) {
      return [...done.slice(0, -1), `${last} ${word}`]
    }
    return [...done, `// ${word}`]
  }, [])
  return lines.join('\n')
}

const INVARIANTS = `// Invariants (docs/adding-a-source.md, "Invariants every adapter keeps"):
// - Pure: parse reads only its arguments. "today" and "now" come from ctx, never the clock.
// - Instants are UTC with a trailing Z: isoToInstant for zoned times, localTime for zone-less ones.
// - TimeBasis says how the source expressed a time: utc, explicit_zone, local_assumed or date_only.
// - Every candidate carries a SourceRef from refFactory; (sourceFile, sourceRecordId) is unique per
//   candidate type.
// - providerKey is "<system>:<account>"; propertyKey is "<system>:<account>:<native or derived id>".
// - Homeowner PII only in ContactPii and notesRaw. Issue messages carry IDs, file names and codes.
// - endAt is null when the source gives no end; never invent one.
// - Statuses go through statusTable/mapStatus, and every job through finishJob.
// - 'error' issues only for a file the adapter cannot read: any error fails npm run ingest.
// - No schema or core changes for one source; if a fact does not fit the candidate types, stop.`

/** The format-specific reader: imports, helpers and the body of parseFile. */
function readerFor(format: Format): { imports: string[]; helpers: string; body: string } {
  if (format === 'csv') {
    return {
      imports: ["import { parse } from 'csv-parse/sync'"],
      helpers: `interface Row {
  record: Record<string, string>
  info: { lines: number }
}

function readRows(content: string): Row[] | null {
  try {
    // With \`columns\` and \`info\`, csv-parse returns { record, info } objects; its types do not say so.
    return parse(content, {
      columns: true,
      info: true,
      relax_column_count: true,
      skip_empty_lines: true,
      bom: true,
    }) as unknown as Row[]
  } catch {
    return null
  }
}`,
      body: `const rows = readRows(file.content)
  if (rows === null) {
    return {
      ...emptyBatch(),
      issues: [
        makeIssue(refOf(fileName(file.path)), 'error', 'file.invalid_csv', \`\${fileName(file.path)} is not valid CSV\`),
      ],
    }
  }
  return mergeBatches(rows.map((row) => mapRecord(row.record, refOf(\`row:\${String(row.info.lines)}\`))))`,
    }
  }
  if (format === 'ics') {
    return {
      imports: [],
      helpers: `/** One VEVENT's unfolded content lines, e.g. "UID:abc", "DTSTART;TZID=America/Chicago:...". */
type Event = string[]

// TODO: this only splits VEVENTs. A real reader also needs parameters, TZID, all-day dates, RRULE
// and EXDATE expansion within ctx.historyDays/ctx.horizonDays; see ics.ts.
function readEvents(content: string): Event[] | null {
  const lines = content.replace(/\\r\\n/g, '\\n').replace(/\\n[ \\t]/g, '').split('\\n')
  if (lines[0]?.trim() !== 'BEGIN:VCALENDAR') return null
  return lines.reduce<{ events: Event[]; current: Event | null }>(
    (state, line) => {
      if (line === 'BEGIN:VEVENT') return { ...state, current: [] }
      if (state.current === null) return state
      if (line === 'END:VEVENT') return { events: [...state.events, state.current], current: null }
      return { ...state, current: [...state.current, line] }
    },
    { events: [], current: null },
  ).events
}

function uidOf(event: Event): string | null {
  const line = event.find((entry) => entry.startsWith('UID:'))
  return line === undefined ? null : line.slice('UID:'.length).trim()
}`,
      body: `const events = readEvents(file.content)
  if (events === null) {
    return {
      ...emptyBatch(),
      issues: [
        makeIssue(refOf(fileName(file.path)), 'error', 'file.invalid_ics', \`\${fileName(file.path)} is not an iCalendar file\`),
      ],
    }
  }
  // TODO: use "<UID>@<occurrence start as Instant>" as the sourceRecordId once occurrences expand.
  return mergeBatches(events.map((event, index) => mapRecord(event, refOf(uidOf(event) ?? \`event:\${String(index + 1)}\`))))`,
    }
  }
  return {
    imports: [],
    helpers: '',
    body: `const issues: IngestIssue[] = []
  const doc = parseJsonFile(file, refOf(fileName(file.path)), issues)
  // TODO: read the records from wherever the source keeps them.
  const records = arrayAt(doc, 'records').filter(isObject)
  return mergeBatches([
    { ...emptyBatch(), issues },
    ...records.map((record, index) => mapRecord(record, refOf(textAt(record, 'id') ?? \`record:\${String(index + 1)}\`))),
  ])`,
  }
}

function adapterSource(options: Options): string {
  const { name, camelName, role, format } = options
  const reader = readerFor(format)
  const target = ROLE_TARGET[role]
  const recordType = { json: 'JsonObject', csv: 'Record<string, string>', ics: 'Event' }[format]
  const shared = [
    'accountFolder',
    'emptyBatch',
    'fileName',
    'makeIssue',
    'mergeBatches',
    'refFactory',
    'sortByPath',
    ...(format === 'json' ? ['arrayAt', 'isObject', 'parseJsonFile', 'textAt'] : []),
  ].sort()
  const sharedTypes = format === 'json' ? ['type JsonObject'] : []
  const types = [
    'AdapterContext',
    'CandidateBatch',
    ...(format === 'json' ? ['IngestIssue'] : []),
    'SourceAdapter',
    'SourceFile',
    'SourceRef',
    'SourceSystem',
  ]
  return `${reader.imports.join('\n')}
import { ${[...shared, ...sharedTypes].join(', ')} } from './shared.ts'
import type { ${types.join(', ')} } from './types.ts'

${lineComment(`${ROLE_LABEL[role]} adapter for ${name}, scaffolded by \`npm run new-source\`. It reads the files and reports each record as not mapped yet; the TODOs below are the mapping still to write. The steps are in docs/adding-a-source.md and the checks in test/unit/adapters/${camelName}.test.ts.`)}
//
${INVARIANTS}

const SOURCE: SourceSystem = '${name}'

${reader.helpers}

${lineComment(`TODO: map one record to candidates: ${target.hint} Pass ctx in when you need it (localTime, finishJob). Until then every record is reported with an info issue, so npm run ingest shows what is still unmapped.`)}
function mapRecord(record: ${recordType}, ref: SourceRef): CandidateBatch {
  return {
    ...emptyBatch(),
    issues: [
      makeIssue(ref, 'info', \`\${SOURCE}.not_mapped\`, \`Record \${ref.sourceRecordId} in \${fileName(ref.sourceFile)} is not mapped yet (\${String(Object.keys(record).length)} fields)\`),
    ],
  }
}

function parseFile(file: SourceFile, ctx: AdapterContext): CandidateBatch {
  // TODO: the account is the folder under sources/${name}/. If the source keeps one file per
  // account directly in that folder, use fileStem(file.path) and change the pattern to match.
  const refOf = refFactory(SOURCE, accountFolder(file.path), file.path, ctx)
  ${reader.body}
}

/** ${ROLE_LABEL[role]}: one folder per account under sources/${name}/, ${format.toUpperCase()} files in each. */
export const ${camelName}Adapter: SourceAdapter = {
  sourceSystem: SOURCE,
  // A \`*\` matches within one path segment (src/ingest/files.ts).
  patterns: ['sources/${name}/*/*.${format}'],
  parse(files, ctx) {
    return mergeBatches(sortByPath(files).map((file) => parseFile(file, ctx)))
  },
}
`
}

function testSource(options: Options, fixture: Fixture): string {
  const { name, camelName, role } = options
  const target = ROLE_TARGET[role]
  const firstRecord =
    role === 'other'
      ? `expect(allCandidates(parseFixture()).length).toBeGreaterThan(0)`
      : `expect(parseFixture().${target.key}.length).toBeGreaterThan(0)`
  const helpers = [
    ...(role === 'other' ? ['allCandidates'] : []),
    ...(fixture.pii.length > 0 ? ['expectIssuesFreeOf'] : []),
    'loadFixtureFiles',
    'makeCtx',
  ]
  const piiTest =
    fixture.pii.length > 0
      ? `
  it('keeps invented personal values out of issue messages', () => {
    expectIssuesFreeOf(parseFixture(), ${JSON.stringify(fixture.pii)})
  })
`
      : ''
  return `import { describe, expect, it } from 'vitest'
import { ${camelName}Adapter } from '../../../src/adapters/${camelName}.ts'
import { matchesPattern } from '../../../src/ingest/files.ts'
import { ${helpers.join(', ')} } from './support.ts'

// Scaffolded by \`npm run new-source\`. The contract checks pass now. 'map your first record' is the
// one expected failure until the adapter maps records: then drop its \`.fails\` marker and add a test
// per mapping (docs/adding-a-source.md, step 5).

const files = loadFixtureFiles('${name}')

function parseFixture() {
  return ${camelName}Adapter.parse(files, makeCtx())
}

describe('${camelName}Adapter', () => {
  it('declares its source system and patterns under sources/${name}/', () => {
    expect(${camelName}Adapter.sourceSystem).toBe('${name}')
    expect(${camelName}Adapter.patterns.length).toBeGreaterThan(0)
    ${camelName}Adapter.patterns.forEach((pattern) => {
      expect(pattern.startsWith('sources/${name}/'), pattern).toBe(true)
    })
  })

  it('claims every fixture file', () => {
    expect(files.length).toBeGreaterThan(0)
    files.forEach((file) => {
      expect(${camelName}Adapter.patterns.some((pattern) => matchesPattern(pattern, file.path)), file.path).toBe(true)
    })
  })

  it('returns an empty batch for no files', () => {
    expect(${camelName}Adapter.parse([], makeCtx())).toEqual({
      providers: [],
      properties: [],
      jobs: [],
      calendarBlocks: [],
      declaredHours: [],
      issues: [],
    })
  })

  it('reads the fixtures without error issues', () => {
    expect(parseFixture().issues.filter((issue) => issue.severity === 'error')).toEqual([])
  })

  it('is pure: the same input gives the same output', () => {
    expect(parseFixture()).toEqual(parseFixture())
  })
${piiTest}
  // TODO: remove the marker once the adapter maps a ${target.type} from the fixture.
  it.fails('map your first record', () => {
    ${firstRecord}
  })
})
`
}

// --- planning, writing and checks ----------------------------------------------------------

async function format(relPath: string, content: string): Promise<string> {
  const filepath = path.join(ROOT, relPath)
  const info = await prettier.getFileInfo(filepath)
  if (info.inferredParser === null) return content
  const config = (await prettier.resolveConfig(filepath)) ?? {}
  return prettier.format(content, { ...config, filepath })
}

async function plan(options: Options): Promise<PlannedFile[]> {
  const project = new Project({ useInMemoryFileSystem: true })
  const types = loadSource(project, TYPES_FILE)
  const registry = loadSource(project, REGISTRY_FILE)
  refuseRegistered(options, types, registry)

  const fixture = fixtureFor(options)
  const fixtureDir = `test/fixtures/${options.name}`
  const planned: PlannedFile[] = [
    {
      path: `src/adapters/${options.camelName}.ts`,
      action: 'create',
      content: adapterSource(options),
    },
    { path: TYPES_FILE, action: 'edit', content: editTypes(options, types) },
    { path: REGISTRY_FILE, action: 'edit', content: editRegistry(options, registry) },
    {
      path: `test/unit/adapters/${options.camelName}.test.ts`,
      action: 'create',
      content: testSource(options, fixture),
    },
    { path: `${fixtureDir}/${fixture.file}`, action: 'create', content: fixture.content },
  ]
  planned
    .filter((file) => file.action === 'create' && !file.path.startsWith(`${fixtureDir}/`))
    .forEach((file) => {
      if (existsSync(path.join(ROOT, file.path))) {
        throw new Refusal(`refusing to overwrite ${file.path}: it already exists`)
      }
    })
  if (existsSync(path.join(ROOT, fixtureDir))) {
    throw new Refusal(`refusing to overwrite ${fixtureDir}/: it already exists`)
  }
  return Promise.all(
    planned.map(async (file) => ({ ...file, content: await format(file.path, file.content) })),
  )
}

function write(planned: readonly PlannedFile[]) {
  planned.forEach((file) => {
    const full = path.join(ROOT, file.path)
    mkdirSync(path.dirname(full), { recursive: true })
    // 'wx' fails rather than overwrite a file created since the plan was made.
    writeFileSync(full, file.content, { flag: file.action === 'create' ? 'wx' : 'w' })
  })
}

function runCheck(label: string, command: string, args: readonly string[]): boolean {
  const started = Date.now()
  const result = spawnSync(path.join(ROOT, 'node_modules/.bin', command), args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  if (result.status === 0) {
    console.log(`  ok    ${label} (${seconds} s)`)
    return true
  }
  console.log(`  FAIL  ${label} (${seconds} s)`)
  console.error(`${result.stdout}${result.stderr}`)
  return false
}

function agentPrompt(options: Options): string | null {
  const match = /## Prompt for a coding agent\s+```text\n([\s\S]*?)```/.exec(
    readFileSync(path.join(ROOT, GUIDE), 'utf8'),
  )
  if (match?.[1] === undefined) return null
  return match[1]
    .replaceAll('<camelName>', options.camelName)
    .replaceAll('<folder>', options.name)
    .replaceAll('<name>', options.name)
    .trim()
}

function nextSteps(options: Options, fixturePath: string): string {
  const { name, camelName } = options
  const prompt = agentPrompt(options)
  return `Next steps:
  1. Update ${REGISTRY_TEST} (this script never edits tests): add '${name}' to
     ALL_SYSTEMS, ${camelName}Adapter to the arrayContaining list, and raise toHaveLength by one.
     npm test stays red until you do.
  2. Put the real files in data/sources/${name}/ (git-ignored; or $DATA_PACK_DIR/sources/${name}/)
     and adjust the pattern in src/adapters/${camelName}.ts to their layout.
  3. Replace ${fixturePath}
     with small invented fixtures that mimic the real shape.
  4. Write the mapping (the TODOs in src/adapters/${camelName}.ts), then drop the .fails marker on
     'map your first record' in test/unit/adapters/${camelName}.test.ts and add tests per mapping.
  5. Run npm run check, npm run ingest (0 errors, 0 unmapped statuses, no unclaimed files) and
     npm run eval (6/6).
${
  prompt === null
    ? `\n(The agent prompt block was not found in ${GUIDE}.)\n`
    : `\nOr hand the work to a coding agent with this prompt (from ${GUIDE}):\n\n${prompt}\n`
}`
}

async function main(): Promise<number> {
  const started = Date.now()
  const options = parseOptions(process.argv.slice(2))
  const planned = await plan(options)
  const fixturePath = planned.at(-1)?.path ?? `test/fixtures/${options.name}/`

  console.log(
    `${options.dryRun ? 'Would scaffold' : 'Scaffolding'} ${options.name} (${options.role}, ${options.format}):`,
  )
  planned.forEach((file) => {
    console.log(`  ${file.action === 'create' ? 'create' : 'edit  '}  ${file.path}`)
  })
  console.log(
    `  SOURCE_TRAITS: ${options.name}: { role: '${options.role}', declaredCrmPattern: ${options.crmPattern} }`,
  )
  if (options.dryRun) {
    console.log('\nDry run: nothing was written.')
    return 0
  }

  write(planned)

  const passed = options.skipChecks
    ? (console.log('\nChecks skipped (--skip-checks).'), true)
    : (() => {
        console.log('\nChecks:')
        const typecheck = runCheck('npm run typecheck', 'tsc', ['--noEmit'])
        const tests = runCheck('adapter tests', 'vitest', [
          'run',
          '--project',
          'unit',
          `test/unit/adapters/${options.camelName}.test.ts`,
          'test/unit/adapters/registry-contract.test.ts',
        ])
        return typecheck && tests
      })()

  console.log(`\nScaffolded ${options.name} in ${((Date.now() - started) / 1000).toFixed(1)} s.\n`)
  console.log(nextSteps(options, fixturePath))
  if (!passed) {
    console.error(
      'The files were written, but a check failed (output above). Fix it before going on.',
    )
    return 1
  }
  return 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    if (error instanceof Refusal) {
      console.error(`new-source: ${error.message}`)
      process.exitCode = 2
      return
    }
    throw error
  },
)
