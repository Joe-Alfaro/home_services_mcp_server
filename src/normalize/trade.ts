export const TRADES = [
  'handyman',
  'plumbing',
  'hvac',
  'electrical',
  'cleaning',
  'painting',
  'lawn',
  'pest',
  'appliance',
  'roofing',
  'gutters',
  'garage',
] as const

export type Trade = (typeof TRADES)[number]
export type Service = 'water_heater_replace' | 'water_heater_repair' | 'water_heater_service'

const TRADE_ALIASES: Readonly<Record<string, Trade>> = {
  plumber: 'plumbing',
  'heating and cooling': 'hvac',
  'heating & cooling': 'hvac',
  'air conditioning': 'hvac',
  electrician: 'electrical',
  electric: 'electrical',
  'house cleaning': 'cleaning',
  maid: 'cleaning',
  maids: 'cleaning',
  painter: 'painting',
  'lawn care': 'lawn',
  landscaping: 'lawn',
  'pest control': 'pest',
  'appliance repair': 'appliance',
  roofer: 'roofing',
  gutter: 'gutters',
  'garage door': 'garage',
  'garage doors': 'garage',
}

function isTrade(value: string): value is Trade {
  return (TRADES as readonly string[]).includes(value)
}

/** Profile trades and CRM industries ("HANDYMAN", "Plumbing", "pest") → Trade, else null. */
export function normalizeTrade(raw: string | null): Trade | null {
  if (raw === null) return null
  const text = raw.trim().toLowerCase().replace(/\s+/g, ' ')
  if (isTrade(text)) return text
  return TRADE_ALIASES[text] ?? null
}

interface PhraseRule {
  pattern: RegExp
  trade: Trade
  service?: Service
}

const WATER_HEATER = String.raw`(?:water ?heater|\bwh\b|\bhwh\b)`

/*
 * The curated phrase map (D-019, G21). First match wins, so the order resolves the keyword traps:
 * water heaters before everything, roof/gutter leaks before plumbing leaks, appliances before
 * "no heat", lawn and gutter cleanups before cleaning.
 */
const PHRASE_RULES: readonly PhraseRule[] = [
  {
    pattern: new RegExp(`${WATER_HEATER}.*\\b(?:flush|maint\\w*|service|tune)`),
    trade: 'plumbing',
    service: 'water_heater_service',
  },
  { pattern: /\btankless\b/, trade: 'plumbing', service: 'water_heater_replace' },
  {
    pattern: new RegExp(
      `(?:\\b(?:new|replace\\w*|install\\w*|swap|change ?out)\\b.*${WATER_HEATER})|(?:${WATER_HEATER}.*\\b(?:replace\\w*|install\\w*|swap|change ?out)\\b)`,
    ),
    trade: 'plumbing',
    service: 'water_heater_replace',
  },
  {
    pattern: new RegExp(
      `(?:${WATER_HEATER}.*\\b(?:repair|leak\\w*|not heating|no hot water|pilot)\\b)|\\bpilot light\\b|\\bno hot water\\b`,
    ),
    trade: 'plumbing',
    service: 'water_heater_repair',
  },
  { pattern: new RegExp(WATER_HEATER), trade: 'plumbing' },
  { pattern: /\broof\w*|\bshingles?\b|\bflashing\b/, trade: 'roofing' },
  { pattern: /\bgutters?\b|\bdownspouts?\b/, trade: 'gutters' },
  { pattern: /\bgarage\b|\bdoor opener\b/, trade: 'garage' },
  {
    pattern:
      /\b(?:dryer|washer|dishwasher|fridge|refrigerator|freezer|oven|stove|range|cooktop|microwave|ice maker|appliance)s?\b/,
    trade: 'appliance',
  },
  {
    pattern:
      /\b(?:hvac|a\/c|ac|furnace|heat pump|thermostat|condenser|compressor|ducts?|ductwork|changeout|refrigerant|freon|no heat|no cool|not cooling|tune ?up|air handler)\b/,
    trade: 'hvac',
  },
  {
    pattern:
      /\b(?:pest|termites?|roach(?:es)?|ants?|rodents?|mice|mouse|rats?|bed ?bugs?|mosquito(?:es)?|spiders?|wasps?|scorpions?|extermina\w*)\b/,
    trade: 'pest',
  },
  {
    pattern:
      /\b(?:lawn|mow\w*|yard|landscap\w*|hedges?|leaf|leaves|fall cleanup|spring cleanup|weed\w*|aerat\w*|sod|mulch|sprinklers?|irrigation|tree trim\w*)\b/,
    trade: 'lawn',
  },
  { pattern: /\b(?:paint\w*|stain\w*|primer|repaint\w*)\b/, trade: 'painting' },
  {
    pattern:
      /\b(?:electric\w*|outlets?|breakers?|panel|wiring|rewire|light fixtures?|ceiling fans?|switch(?:es)?|gfci|circuits?|ev charger)\b/,
    trade: 'electrical',
  },
  {
    pattern:
      /\b(?:plumb\w*|leak\w*|drains?|clog\w*|toilets?|faucets?|sinks?|pipes?|sewer|rooter|shower|tub|disposal|water line|hydro ?jet\w*|backflow)\b/,
    trade: 'plumbing',
  },
  {
    pattern: /\b(?:clean\w*|maid|housekeep\w*|move[- ]?out|move[- ]?in)\b/,
    trade: 'cleaning',
  },
  {
    pattern:
      /\b(?:handyman|mount\w*|tv|fence|drywall|patch\w*|shel(?:f|ves)|gate|assembl\w*|blinds|caulk\w*|deck|doors?|cabinet\w*|trim)\b/,
    trade: 'handyman',
  },
]

function normalizeJobText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+-\s+estimate\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The curated phrase map alone (case-insensitive). Unknown text → { trade: null, service: null }. */
export function classifyJobText(text: string | null): {
  trade: Trade | null
  service: Service | null
} {
  if (text === null) return { trade: null, service: null }
  const normalized = normalizeJobText(text)
  if (normalized === '') return { trade: null, service: null }
  const rule = PHRASE_RULES.find((candidate) => candidate.pattern.test(normalized))
  if (rule === undefined) return { trade: null, service: null }
  return { trade: rule.trade, service: rule.service ?? null }
}

export interface TradeConflict {
  kind: 'trade'
  observedTrade: Trade
  reason: 'outside_declared_trades' | 'declared_does_not_do'
}

export interface TradeClassification {
  trade: Trade | null
  service: Service | null
  method: 'provider_trade' | 'phrase_map' | 'none'
  conflict: TradeConflict | null
}

/**
 * D-019: the provider's trade first; the phrase map picks among a multi-trade provider's trades
 * and is used alone only when the provider has no trade. A phrase trade outside the provider's
 * trades is reported, never applied. The service subtype is kept either way.
 */
export function classifyJob(input: {
  text: string | null
  providerTrades: readonly Trade[]
  providerDoesNotDo?: readonly Trade[]
}): TradeClassification {
  const phrase = classifyJobText(input.text)
  const [primary] = input.providerTrades
  if (primary === undefined) {
    if (phrase.trade === null) return { trade: null, service: null, method: 'none', conflict: null }
    return { trade: phrase.trade, service: phrase.service, method: 'phrase_map', conflict: null }
  }
  if (phrase.trade === null || input.providerTrades.includes(phrase.trade)) {
    return {
      trade: phrase.trade ?? primary,
      service: phrase.service,
      method: 'provider_trade',
      conflict: null,
    }
  }
  const doesNotDo = input.providerDoesNotDo ?? []
  return {
    trade: primary,
    service: phrase.service,
    method: 'provider_trade',
    conflict: {
      kind: 'trade',
      observedTrade: phrase.trade,
      reason: doesNotDo.includes(phrase.trade) ? 'declared_does_not_do' : 'outside_declared_trades',
    },
  }
}
