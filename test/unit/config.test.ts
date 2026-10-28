import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig, REPO_ROOT } from '../../src/config.ts'

describe('loadConfig', () => {
  it('uses dev defaults when env is empty', () => {
    const config = loadConfig({})

    expect(config.databaseUrl).toBe('postgres://hsmcp:hsmcp@localhost:5434/hsmcp')
    expect(config.dataPackDir).toBe(path.join(REPO_ROOT, 'data'))
    expect(config.today).toBe('2026-11-02')
    expect(config.timeZone).toBe('America/Chicago')
    expect(config.now).toBe('2026-11-02T06:00:00.000Z')
  })

  it('builds the default database URL from HSMCP_DB_PORT', () => {
    expect(loadConfig({ HSMCP_DB_PORT: '6543' }).databaseUrl).toBe(
      'postgres://hsmcp:hsmcp@localhost:6543/hsmcp',
    )
  })

  it('prefers an explicit DATABASE_URL', () => {
    const url = 'postgres://u:p@db.example:5432/other'
    expect(loadConfig({ DATABASE_URL: url, HSMCP_DB_PORT: '6543' }).databaseUrl).toBe(url)
  })

  it('resolves a relative DATA_PACK_DIR against the repo root', () => {
    expect(loadConfig({ DATA_PACK_DIR: 'fixtures/pack' }).dataPackDir).toBe(
      path.join(REPO_ROOT, 'fixtures/pack'),
    )
  })

  it('keeps an absolute DATA_PACK_DIR', () => {
    expect(loadConfig({ DATA_PACK_DIR: '/tmp/pack' }).dataPackDir).toBe('/tmp/pack')
  })

  it('accepts a configured HS_TODAY', () => {
    expect(loadConfig({ HS_TODAY: '2026-12-24' }).today).toBe('2026-12-24')
  })

  it.each(['2026-13-01', '2026-02-30', 'tomorrow', '2026-11-2', ''])(
    'rejects invalid HS_TODAY %j',
    (today) => {
      expect(() => loadConfig({ HS_TODAY: today })).toThrow(/HS_TODAY/)
    },
  )

  it('defaults now to local midnight of a configured HS_TODAY', () => {
    // 2026-11-01 is the DST change day; midnight is still CDT (-05:00).
    expect(loadConfig({ HS_TODAY: '2026-11-01' }).now).toBe('2026-11-01T05:00:00.000Z')
    expect(loadConfig({ HS_TODAY: '2026-12-24' }).now).toBe('2026-12-24T06:00:00.000Z')
  })

  it('reads a zone-less HS_NOW as America/Chicago', () => {
    expect(loadConfig({ HS_NOW: '2026-11-02T09:30' }).now).toBe('2026-11-02T15:30:00.000Z')
  })

  it('keeps an HS_NOW that carries its own offset', () => {
    expect(loadConfig({ HS_NOW: '2026-11-02T12:00:00Z' }).now).toBe('2026-11-02T12:00:00.000Z')
  })

  it('rejects an invalid HS_NOW', () => {
    expect(() => loadConfig({ HS_NOW: 'noon' })).toThrow(/HS_NOW/)
  })

  it('rejects a non-numeric HSMCP_DB_PORT', () => {
    expect(() => loadConfig({ HSMCP_DB_PORT: 'abc' })).toThrow(/HSMCP_DB_PORT/)
  })

  it('never reads the system clock for today', () => {
    expect(loadConfig({}).today).not.toBe(new Date().toISOString().slice(0, 10))
  })
})
