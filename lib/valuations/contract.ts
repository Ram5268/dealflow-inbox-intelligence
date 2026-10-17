// Brief 44 — the contract between the monthly valuation job (valuation/, Python on
// GitHub Actions) and DealFlow's protected POST /api/valuations/import.
//
// The job sends one run in three steps:
//   1. { action: 'start',   run }               records the run and its publish checks
//   2. { action: 'rows',    runId, rows }       up to 200 sellers per request (Vercel caps a body at 4.5 MB)
//   3. { action: 'publish', runId }             makes the run's values the ones the CRM card reads
// Re-sending any step is harmless (idempotent per run id). A run whose checks fail is
// recorded by step 1 only, so the last published values stay in place.
//
// Every field is whitelisted (unknown keys are refused). No owner, party or
// homeowner name ever travels here: Ryan's decision (2026-10-17) that PLUTO owner
// names stay erased, and an engineering precaution for everything else.
import { z } from 'zod'

export const MAX_ROWS_PER_BATCH = 200
export const MAX_COMPS = 8
export const MAX_BODY_BYTES = 4_000_000 // under Vercel's 4.5 MB request cap

// Why a home has no value. The card turns each into a sentence.
export const NO_VALUE_REASONS = ['five_plus_units', 'condo_without_unit', 'not_found', 'other_property_type'] as const
export type NoValueReason = (typeof NO_VALUE_REASONS)[number]

// Publish gates (engineering precautions, Brief 44 §5). The job checks them on the
// three most recent complete months, out of sample; this server checks them again
// before it publishes.
export const GATE_KEYS = ['typical_miss_all', 'typical_miss_top8_2to4', 'range_coverage', 'sellers_valued'] as const
export type GateKey = (typeof GATE_KEYS)[number]
export const GATE_LIMITS: Record<GateKey, { min?: number; max?: number }> = {
  typical_miss_all: { max: 0.115 }, //        Brooklyn/Queens 1-4 family homes, median miss
  typical_miss_top8_2to4: { max: 0.145 }, //  2-4 family homes in Ryan's 8 neighborhoods
  range_coverage: { min: 0.6, max: 0.75 }, // share of sales inside the 2-in-3 range
  sellers_valued: { min: 1300 }, //           CRM sellers with a value
}

const int0 = z.number().int().min(0).max(1_000_000)
const money = z.number().finite().positive().max(1_000_000_000)
const area = z.number().finite().positive().max(10_000_000)
const isoDate = z.iso.date()
// Codes only (zoning "R6B", "C4-4A", "M1-2/R6A"); never free text.
const code = (max: number) => z.string().min(1).max(max).regex(/^[A-Z0-9/.-]+$/)

// The facts the CRM card shows (Brief 44 §5 whitelist).
export const FactsSchema = z.strictObject({
  units: int0.nullable(), //                     residential units, per the city
  buildingSqft: area.nullable(),
  lotSqft: area.nullable(),
  yearBuilt: z.number().int().min(1700).max(2100).nullable(),
  floors: z.number().min(0).max(200).nullable(),
  zoning: code(16).nullable(),
  buildingClass: z.string().regex(/^[A-Z][0-9A-Z]$/).nullable(), // DOF building class, e.g. "B1"
  historicDistrict: z.boolean().nullable(),
  lastSale: z.strictObject({ date: isoDate, price: money }).nullable(), // last arm's-length sale
  dofMarketValue: z.strictObject({ value: money, fiscalYear: z.number().int().min(2000).max(2100) }).nullable(),
  permits7y: z.strictObject({ count: int0, major: z.boolean() }), // alteration permits, last 7 years
  openViolations: z.strictObject({ dob: int0, ecb: int0, hpd: int0 }),
  taxLienNotice: z.boolean(), //                 on a city tax-lien-sale notice list
  subwayMiles: z.number().min(0).max(25).nullable(),
  leadVsCity: z.strictObject({ //                set only where the lead and the city disagree
    units: z.strictObject({ lead: int0, city: int0 }).nullable(),
    buildingSqft: z.strictObject({ lead: area, city: area }).nullable(),
  }),
})
export type Facts = z.infer<typeof FactsSchema>

// A nearby earlier arm's-length sale: a public record. Ryan said yes (2026-10-17) to
// showing these addresses on his CRM card.
export const CompSchema = z.strictObject({
  address: z.string().min(1).max(80).regex(/^[A-Za-z0-9 #&'(),./-]+$/),
  date: isoDate,
  price: money,
  pricePerSqft: z.number().finite().positive().max(50_000),
  distanceMiles: z.number().min(0).max(5),
})
export type Comp = z.infer<typeof CompSchema>

export const RowSchema = z
  .strictObject({
    contactId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
    bbl: z.string().regex(/^[1-5]\d{9}$/).nullable(),
    value: money.nullable(),
    low: money.nullable(),
    high: money.nullable(),
    reason: z.enum(NO_VALUE_REASONS).nullable(),
    facts: FactsSchema.nullable(),
    comps: z.array(CompSchema).max(MAX_COMPS),
  })
  .superRefine((r, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message })
    if (r.value != null) {
      if (r.low == null || r.high == null) fail('a value needs its low and high')
      else if (!(r.low <= r.value && r.value <= r.high)) fail('low <= value <= high')
      else if (r.low < 0.5 * r.value || r.high > 2 * r.value) fail('the range is implausibly wide')
      if (r.reason != null) fail('a valued home has no reason')
      if (r.bbl == null || r.facts == null) fail('a valued home needs its tax lot and facts')
    } else {
      if (r.low != null || r.high != null) fail('no value means no range')
      if (r.reason == null) fail('a home without a value needs a reason')
      if (r.comps.length > 0) fail('nearby sales come only with a value')
      if (r.reason === 'not_found' && (r.bbl != null || r.facts != null)) fail('not_found has no tax lot or facts')
      if (r.reason != null && r.reason !== 'not_found' && r.bbl == null) fail('this reason needs the tax lot')
    }
  })
export type ValuationRow = z.infer<typeof RowSchema>

// Run metadata is aggregate numbers only. A personal-looking key anywhere inside is
// refused (engineering precaution: these blobs are never meant to carry a person).
const PERSONAL_KEY = /name|owner|party|phone|email|address|contact/i
function hasPersonalKey(v: unknown, depth = 0): boolean {
  if (depth > 8 || v == null || typeof v !== 'object') return false
  if (Array.isArray(v)) return v.some(x => hasPersonalKey(x, depth + 1))
  return Object.entries(v).some(([k, x]) => PERSONAL_KEY.test(k) || hasPersonalKey(x, depth + 1))
}
const blob = z
  .record(z.string(), z.unknown())
  .refine(v => JSON.stringify(v).length <= 64_000, 'too large')
  .refine(v => !hasPersonalKey(v), 'personal-looking key')

export const GateCheckSchema = z.strictObject({ key: z.enum(GATE_KEYS), value: z.number().finite(), pass: z.boolean() })

export const RunSchema = z.strictObject({
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{7,63}$/),
  runAt: z.iso.datetime({ offset: true }),
  asOf: isoDate,
  dataThrough: isoDate,
  modelVersion: z.string().min(1).max(80),
  gates: z.strictObject({ passed: z.boolean(), checks: z.array(GateCheckSchema).length(GATE_KEYS.length) }),
  metrics: blob,
  scoreboard: blob.nullable(),
  sources: blob.nullable(),
  counts: z.strictObject({
    targets: int0,
    valued: int0,
    five_plus_units: int0,
    condo_without_unit: int0,
    not_found: int0,
    other_property_type: int0,
    trainingSales: int0,
    gateSales: int0,
  }),
  expectedRows: z.number().int().min(1).max(20_000),
})
export type ValuationRunInput = z.infer<typeof RunSchema>

export const ImportSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start'), run: RunSchema }),
  z.strictObject({
    action: z.literal('rows'),
    runId: RunSchema.shape.runId,
    rows: z.array(RowSchema).min(1).max(MAX_ROWS_PER_BATCH),
  }),
  z.strictObject({ action: z.literal('publish'), runId: RunSchema.shape.runId }),
])
export type ImportPayload = z.infer<typeof ImportSchema>

export interface CheckedGate {
  key: GateKey
  value: number
  min: number | null
  max: number | null
  pass: boolean
}

// Recomputes every gate from its reported value against this server's limits. All
// four must be present exactly once; anything missing, repeated or unknown fails.
export function recheckGates(checks: unknown): { passed: boolean; checks: CheckedGate[] } {
  const parsed = z.array(GateCheckSchema).safeParse(checks)
  const list = parsed.success ? parsed.data : []
  const out: CheckedGate[] = []
  for (const key of GATE_KEYS) {
    const mine = list.filter(c => c.key === key)
    const { min, max } = GATE_LIMITS[key]
    const value = mine.length === 1 ? mine[0].value : NaN
    const pass = Number.isFinite(value) && (min == null || value >= min) && (max == null || value <= max)
    out.push({ key, value, min: min ?? null, max: max ?? null, pass: mine.length === 1 && pass })
  }
  return { passed: list.length === GATE_KEYS.length && out.every(c => c.pass), checks: out }
}

// Where a payload was refused, without echoing any of its values.
export function issueList(error: z.ZodError, limit = 20): string[] {
  return error.issues.slice(0, limit).map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
}
