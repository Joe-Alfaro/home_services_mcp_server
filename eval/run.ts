/**
 * Eval harness (R29): starts the MCP server over stdio as a child process, asks Q1-Q6 through the
 * one intended tool each (R18 d: one call, no retries, no LLM), compares every response with
 * eval/expected/qN.json and prints per-question PASS/FAIL plus the pass rate. Exits 1 when any
 * question fails.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { isObject, type Json } from './checks/common.ts'
import { buildQuestions, type Question } from './questions.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const START_TIMEOUT_MS = Number(process.env.EVAL_START_TIMEOUT_MS ?? 60_000)
const CALL_TIMEOUT_MS = Number(process.env.EVAL_CALL_TIMEOUT_MS ?? 120_000)
const MAX_LINES = 12
// The expected answers are pinned to this snapshot; the server must not use another "today".
const SNAPSHOT_TODAY = '2026-11-02'

interface Outcome {
  question: Question
  pass: boolean
  failures: string[]
  notes: string[]
  ms: number
}

/** The command behind `npm start`, run directly so closing the transport stops the real server. */
function serverCommand(): { command: string; args: string[] } {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  const [bin, ...args] = (pkg.scripts?.start ?? '').trim().split(/\s+/)
  if (bin === undefined || bin === '') throw new Error('package.json has no "start" script')
  const local = path.join(repoRoot, 'node_modules', '.bin', bin)
  return { command: existsSync(local) ? local : bin, args }
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  Object.entries(process.env).forEach(([k, v]) => {
    if (v !== undefined && k !== 'HS_NOW') env[k] = v
  })
  env.HS_TODAY = SNAPSHOT_TODAY
  return env
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message))
    }, ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function connect(): Promise<{ client: Client } | { error: string }> {
  const stderr: string[] = []
  let transport: StdioClientTransport | undefined
  try {
    const { command, args } = serverCommand()
    transport = new StdioClientTransport({
      command,
      args,
      env: childEnv(),
      cwd: repoRoot,
      stderr: 'pipe',
    })
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk.toString('utf8'))
    })
    const client = new Client({ name: 'hsmcp-eval', version: '0.1.0' })
    await withTimeout(
      client.connect(transport),
      START_TIMEOUT_MS,
      `no MCP handshake within ${String(START_TIMEOUT_MS / 1000)} s`,
    )
    return { client }
  } catch (error) {
    await transport?.close().catch(() => undefined)
    const tail = stderr.join('').trim().split('\n').slice(-3).join(' | ')
    return { error: tail === '' ? errorText(error) : `${errorText(error)} (stderr: ${tail})` }
  }
}

async function toolNames(client: Client): Promise<Set<string>> {
  try {
    const { tools } = await client.listTools(undefined, { timeout: CALL_TIMEOUT_MS })
    return new Set(tools.map((t) => t.name))
  } catch {
    // A server with no tools registered may not advertise the tools capability at all.
    return new Set()
  }
}

function textOf(result: Record<string, unknown>): string | undefined {
  const content = result.content
  if (!Array.isArray(content)) return undefined
  const block: unknown = content.find(
    (c: unknown) => isObject(c) && (c as { type?: unknown }).type === 'text',
  )
  const text = (block as { text?: unknown } | undefined)?.text
  return typeof text === 'string' ? text : undefined
}

/** The tool's answer as JSON: structuredContent when present, else the first text block parsed. */
export function payloadOf(result: Record<string, unknown>): Json {
  if (isObject(result.structuredContent)) return result.structuredContent
  const text = textOf(result)
  if (text === undefined) throw new Error('response has neither structuredContent nor a text block')
  try {
    return JSON.parse(text) as Json
  } catch {
    throw new Error(`response text is not JSON: ${text.slice(0, 120)}`)
  }
}

function fail(question: Question, started: number, message: string): Outcome {
  return { question, pass: false, failures: [message], notes: [], ms: Date.now() - started }
}

async function ask(client: Client, question: Question, tools: Set<string>): Promise<Outcome> {
  const started = Date.now()
  if (!tools.has(question.tool)) {
    const listed = tools.size === 0 ? 'none' : [...tools].sort().join(', ')
    return fail(question, started, `tool not found: ${question.tool} (server lists: ${listed})`)
  }
  let result: Record<string, unknown>
  try {
    result = await client.callTool({ name: question.tool, arguments: question.args }, undefined, {
      timeout: CALL_TIMEOUT_MS,
    })
  } catch (error) {
    return fail(question, started, `call failed: ${errorText(error)}`)
  }
  if (result.isError === true) {
    return fail(
      question,
      started,
      `tool returned an error: ${(textOf(result) ?? '').slice(0, 300)}`,
    )
  }
  let payload: Json
  try {
    payload = payloadOf(result)
  } catch (error) {
    return fail(question, started, errorText(error))
  }
  const { failures, notes } = question.check(payload)
  return { question, pass: failures.length === 0, failures, notes, ms: Date.now() - started }
}

function report(outcome: Outcome): void {
  const { question, pass, failures, notes, ms } = outcome
  console.log(
    `${question.id} ${pass ? 'PASS' : 'FAIL'}  ${question.tool}  (${(ms / 1000).toFixed(1)} s)`,
  )
  failures.slice(0, MAX_LINES).forEach((f) => {
    console.log(`    - ${f}`)
  })
  if (failures.length > MAX_LINES) {
    console.log(`    - … ${String(failures.length - MAX_LINES)} more`)
  }
  notes.forEach((n) => {
    console.log(`    · ${n}`)
  })
}

async function main(): Promise<number> {
  const questions = buildQuestions()
  console.log('eval: Q1-Q6 against the MCP server over stdio (one call per question, no retries)')
  const connection = await connect()
  const outcomes: Outcome[] = []
  if ('error' in connection) {
    questions.forEach((q) => {
      outcomes.push(fail(q, Date.now(), `server not ready: ${connection.error}`))
    })
  } else {
    const tools = await toolNames(connection.client)
    // Sequential on purpose: one stdio server, and timings stay per question.
    await questions.reduce(async (previous, q) => {
      await previous
      outcomes.push(await ask(connection.client, q, tools))
    }, Promise.resolve())
    await connection.client.close().catch(() => undefined)
  }
  outcomes.forEach(report)
  const passed = outcomes.filter((o) => o.pass).length
  const pct = Math.round((passed / outcomes.length) * 100)
  console.log(`\npass rate: ${String(passed)}/${String(outcomes.length)} (${String(pct)}%)`)
  return passed === outcomes.length ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`eval: harness error: ${errorText(error)}`)
    process.exit(2)
  },
)
