import { describe, expect, it } from 'vitest'
import {
  TRADES,
  classifyJob,
  classifyJobText,
  normalizeTrade,
} from '../../../src/normalize/trade.ts'

/*
 * API pinned for src/normalize/trade.ts:
 *
 * export const TRADES: readonly [
 *   'handyman', 'plumbing', 'hvac', 'electrical', 'cleaning', 'painting',
 *   'lawn', 'pest', 'appliance', 'roofing', 'gutters', 'garage',
 * ]
 * export type Trade = (typeof TRADES)[number]
 * export type Service = 'water_heater_replace' | 'water_heater_repair' | 'water_heater_service'
 *
 * // Profile trades and CRM industries ("HANDYMAN", "Plumbing", "pest") → Trade, else null.
 * export function normalizeTrade(raw: string | null): Trade | null
 *
 * // The curated phrase map alone (case-insensitive). Unknown text → { trade: null, service: null }.
 * export function classifyJobText(text: string | null): { trade: Trade | null; service: Service | null }
 *
 * // D-019: the provider's trade first, refined by the phrase map; observed-trade conflicts reported.
 * export interface TradeConflict {
 *   kind: 'trade'
 *   observedTrade: Trade
 *   reason: 'outside_declared_trades' | 'declared_does_not_do'
 * }
 * export interface TradeClassification {
 *   trade: Trade | null
 *   service: Service | null
 *   method: 'provider_trade' | 'phrase_map' | 'none'
 *   conflict: TradeConflict | null
 * }
 * export function classifyJob(input: {
 *   text: string | null
 *   providerTrades: readonly Trade[]   // declared/canonical, primary first
 *   providerDoesNotDo?: readonly Trade[]
 * }): TradeClassification
 */

describe('TRADES and normalizeTrade', () => {
  it('lists the canonical trade vocabulary', () => {
    expect([...TRADES].sort()).toEqual(
      [
        'appliance',
        'cleaning',
        'electrical',
        'garage',
        'gutters',
        'handyman',
        'hvac',
        'lawn',
        'painting',
        'pest',
        'plumbing',
        'roofing',
      ].sort(),
    )
  })

  it.each([
    ['HANDYMAN', 'handyman'],
    ['Handyman', 'handyman'],
    ['PLUMBING', 'plumbing'],
    ['plumbing', 'plumbing'],
    ['HVAC', 'hvac'],
    ['ELECTRICAL', 'electrical'],
    ['CLEANING', 'cleaning'],
    ['LAWN', 'lawn'],
    ['PEST', 'pest'],
    ['PAINTING', 'painting'],
    ['appliance', 'appliance'],
    ['roofing', 'roofing'],
    ['gutters', 'gutters'],
    ['garage', 'garage'],
  ])('%j → %j', (raw, expected) => {
    expect(normalizeTrade(raw)).toBe(expected)
  })

  it('returns null for unknown or blank trades', () => {
    expect(normalizeTrade('astrology')).toBeNull()
    expect(normalizeTrade('')).toBeNull()
    expect(normalizeTrade(null)).toBeNull()
  })
})

describe('classifyJobText: water-heater phrasings (R4 (f), G21, D-019)', () => {
  it.each([
    'new water heater',
    'WH replace',
    'Replace water heater - gas 40G',
    'Water Heater Install 50gal',
    'Water heater replacement',
    'Tankless conversion',
  ])('%j → plumbing / water_heater_replace', (text) => {
    expect(classifyJobText(text)).toEqual({ trade: 'plumbing', service: 'water_heater_replace' })
  })

  it.each(['Water heater repair', 'WH no hot water', 'pilot light out'])(
    '%j → plumbing / water_heater_repair',
    (text) => {
      expect(classifyJobText(text)).toEqual({ trade: 'plumbing', service: 'water_heater_repair' })
    },
  )

  it('"Water heater flush" → plumbing / water_heater_service', () => {
    expect(classifyJobText('Water heater flush')).toEqual({
      trade: 'plumbing',
      service: 'water_heater_service',
    })
  })

  it('maps the Housecall Pro " - estimate" variants the same way', () => {
    expect(classifyJobText('Water heater replacement - estimate').service).toBe(
      'water_heater_replace',
    )
    expect(classifyJobText('WH no hot water - estimate').service).toBe('water_heater_repair')
  })

  it.each([
    ['wh replace', 'WH REPLACE'],
    ['water heater flush', 'WATER HEATER FLUSH'],
    ['Mount TV', 'mount tv'],
    ['  Tankless   conversion ', 'tankless conversion'],
  ])('case and spacing variants %j and %j map alike', (a, b) => {
    expect(classifyJobText(a)).toEqual(classifyJobText(b))
  })
})

describe('classifyJobText: keyword traps across trades (G21)', () => {
  it('"changeout" is HVAC, not a water heater', () => {
    expect(classifyJobText('changeout')).toEqual({ trade: 'hvac', service: null })
  })

  it('"leak in roof" is roofing, not plumbing', () => {
    expect(classifyJobText('leak in roof').trade).toBe('roofing')
  })

  it('"dryer no heat" is appliance, not HVAC', () => {
    expect(classifyJobText('dryer no heat').trade).toBe('appliance')
  })

  it('"fall cleanup" is not cleaning', () => {
    expect(classifyJobText('fall cleanup').trade).not.toBe('cleaning')
  })

  it('"gutters cleaned" is not cleaning', () => {
    expect(classifyJobText('gutters cleaned').trade).not.toBe('cleaning')
  })

  it('unknown or blank text maps to nothing', () => {
    expect(classifyJobText('misc')).toEqual({ trade: null, service: null })
    expect(classifyJobText('')).toEqual({ trade: null, service: null })
    expect(classifyJobText(null)).toEqual({ trade: null, service: null })
  })
})

describe('classifyJob: provider trade first (D-019, D-020, G23)', () => {
  it('a plumber’s water-heater job keeps plumbing and gets the service subtype', () => {
    expect(classifyJob({ text: 'WH replace', providerTrades: ['plumbing'] })).toEqual({
      trade: 'plumbing',
      service: 'water_heater_replace',
      method: 'provider_trade',
      conflict: null,
    })
  })

  it('an unmapped job text takes the provider’s trade', () => {
    expect(classifyJob({ text: 'misc', providerTrades: ['handyman'] })).toMatchObject({
      trade: 'handyman',
      service: null,
      method: 'provider_trade',
      conflict: null,
    })
  })

  it('a phrase never overrides the provider’s trade; the observed trade is reported', () => {
    expect(classifyJob({ text: 'dryer no heat', providerTrades: ['hvac'] })).toEqual({
      trade: 'hvac',
      service: null,
      method: 'provider_trade',
      conflict: { kind: 'trade', observedTrade: 'appliance', reason: 'outside_declared_trades' },
    })
  })

  it('work the profile says the provider does not do is reported as declared_does_not_do', () => {
    const result = classifyJob({
      text: 'WH no hot water',
      providerTrades: ['handyman'],
      providerDoesNotDo: ['plumbing', 'electrical'],
    })
    expect(result.trade).toBe('handyman')
    expect(result.service).toBe('water_heater_repair')
    expect(result.conflict).toEqual({
      kind: 'trade',
      observedTrade: 'plumbing',
      reason: 'declared_does_not_do',
    })
  })

  it('the phrase map picks between the trades of a multi-trade provider', () => {
    expect(
      classifyJob({ text: 'interior painting', providerTrades: ['handyman', 'painting'] }),
    ).toMatchObject({ trade: 'painting', conflict: null })
    expect(classifyJob({ text: 'misc', providerTrades: ['handyman', 'painting'] })).toMatchObject({
      trade: 'handyman',
      conflict: null,
    })
  })

  it('falls back to the phrase map when the provider has no known trade', () => {
    expect(classifyJob({ text: 'Water heater flush', providerTrades: [] })).toEqual({
      trade: 'plumbing',
      service: 'water_heater_service',
      method: 'phrase_map',
      conflict: null,
    })
  })

  it('returns no trade when neither the provider nor the text gives one', () => {
    expect(classifyJob({ text: 'misc', providerTrades: [] })).toEqual({
      trade: null,
      service: null,
      method: 'none',
      conflict: null,
    })
  })
})
