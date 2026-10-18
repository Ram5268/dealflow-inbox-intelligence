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
// Every field is whitelisted (unknown keys are refused, at every level). No owner,
// party or homeowner name ever travels here: Ryan's decision (2026-10-17) that PLUTO
// owner names stay erased, and an engineering precaution for everything else. The
// run's metrics and scoreboard are number trees (no text at all), and a refusal names
// where it happened, never a value or an unknown key.
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

// The facts the CRM card shows (Brief 44 §5 whitelist). There is no tax-lien field:
// Brief 44 Revision 5 leaves the city's tax-lien-sale list out (data minimization,
// an engineering precaution).
export const FactsSchema = z.strictObject({
  units: int0.nullable(), //                     residential units, per the city (PLUTO)
  buildingSqft: area.nullable(),
  lotSqft: area.nullable(),
  yearBuilt: z.number().int().min(1700).max(2100).nullable(),
  floors: z.number().min(0).max(200).nullable(),
  zoning: code(16).nullable(),
  buildingClass: z.string().regex(/^[A-Z][0-9A-Z]$/).nullable(), // DOF building class, e.g. "B1"
  historicDistrict: z.boolean().nullable(),
  lastSale: z.strictObject({ date: isoDate, price: money }).nullable(), // last arm's-length sale, before the run's asOf
  dofMarketValue: z.strictObject({ value: money, fiscalYear: z.number().int().min(2000).max(2100) }).nullable(),
  permits7y: z.strictObject({ count: int0, major: z.boolean() }), // DOB alteration permits, last 7 years
  openViolations: z.strictObject({ dob: int0, ecb: int0, hpd: int0 }),
  subwayMiles: z.number().min(0).max(25).nullable(), // nearest subway station
  leadVsCity: z.strictObject({ //                set only where the lead and the city disagree
    units: z.strictObject({ lead: int0, city: int0 }).nullable(),
    buildingSqft: z.strictObject({ lead: area, city: area }).nullable(),
  }),
})
export type Facts = z.infer<typeof FactsSchema>

// A nearby earlier arm's-length sale: a public record. Ryan said yes (2026-10-17) to
// showing these addresses on his CRM card. The address must start with a house
// number ("200 ...", Queens' "12-34 ...", "12A ..."), so a bare name can't pass for
// one (engineering precaution).
export const COMP_ADDRESS = /^[0-9]+(-[0-9]+)?[A-Z]? [A-Za-z0-9 #&'().,/-]{2,72}$/
export const CompSchema = z.strictObject({
  address: z.string().regex(COMP_ADDRESS),
  date: isoDate, // before the run's asOf (checked against the run: rowDateProblems)
  price: money,
  pricePerSqft: z.number().finite().positive().max(50_000),
  distanceMiles: z.number().min(0).max(1.5),
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

// ── Number trees: the run's metrics and matching scoreboard ──────────────────────
// Engineering precaution: these blobs must never be able to carry a person. A JSON
// object whose keys are lowercase codes and whose values are finite numbers,
// true/false, null, lists of up to 64 of those, or nested objects of the same kind:
// no text anywhere. Deeper than 6 levels (the outer object is level 1) or bigger
// than 64,000 bytes is refused, never cut short. A refusal names neither keys nor values.
export const TREE_KEY = /^[a-z0-9][a-z0-9_]{0,47}$/
export const TREE_MAX_DEPTH = 6
export const TREE_MAX_LIST = 64
export const TREE_MAX_BYTES = 64_000
type Scalar = number | boolean | null
export type NumberTree = { [key: string]: Scalar | Scalar[] | NumberTree }

const isScalar = (v: unknown): v is Scalar => v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v))

// Why `v` isn't a number tree, or null when it is one.
export function numberTreeProblem(v: unknown): string | null {
  const walk = (node: Record<string, unknown>, level: number): string | null => {
    for (const [key, x] of Object.entries(node)) {
      if (!TREE_KEY.test(key)) return `level ${level}: a key is not a lowercase code`
      if (isScalar(x)) continue
      if (typeof x === 'string') return `level ${level}: text is not allowed`
      if (!Array.isArray(x) && !isPlainObject(x)) return `level ${level}: only numbers, true/false, null, lists and objects`
      if (level + 1 > TREE_MAX_DEPTH) return `nested deeper than ${TREE_MAX_DEPTH} levels`
      if (Array.isArray(x)) {
        if (x.length > TREE_MAX_LIST) return `level ${level + 1}: a list longer than ${TREE_MAX_LIST}`
        if (!x.every(isScalar)) return `level ${level + 1}: a list holds only numbers, true/false or null`
        continue
      }
      const deeper = walk(x, level + 1)
      if (deeper) return deeper
    }
    return null
  }
  if (!isPlainObject(v)) return 'must be an object'
  const problem = walk(v, 1)
  if (problem) return problem
  return Buffer.byteLength(JSON.stringify(v), 'utf8') > TREE_MAX_BYTES ? `larger than ${TREE_MAX_BYTES} bytes` : null
}

const numberTree = z.custom<NumberTree>().superRefine((v, ctx) => {
  const problem = numberTreeProblem(v)
  if (problem) ctx.addIssue({ code: 'custom', message: problem })
})

// ── Sources: the public data versions a run used (the card's sources footer) ────
// Strict. Dataset ids are checked here rather than by z.record, so a refusal never
// repeats a key it was sent.
const DATASET_ID = /^([a-z0-9]{4}-[a-z0-9]{4}|dof_annual)$/ // a NYC Open Data id, or DOF's annual sales files
export const MAX_DATASETS = 30
const DatasetSchema = z.strictObject({ updatedOn: isoDate.nullable(), rows: z.number().int().min(0) })
export type DatasetVersion = z.infer<typeof DatasetSchema>
const datasets = z.custom<Record<string, DatasetVersion>>().superRefine((v, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message })
  if (!isPlainObject(v)) return fail('must be an object')
  const entries = Object.entries(v)
  if (entries.length > MAX_DATASETS) return fail(`more than ${MAX_DATASETS} datasets`)
  if (entries.some(([id]) => !DATASET_ID.test(id))) return fail('a dataset id is not a city dataset id')
  if (entries.some(([, entry]) => !DatasetSchema.safeParse(entry).success)) return fail('each dataset is { updatedOn: ISO date or null, rows: whole number }')
})
export const SourcesSchema = z.strictObject({
  downloadedOn: isoDate, //  when the public files were downloaded
  salesThrough: isoDate, //  the last DOF sale date in the files
  plutoVersion: z.string().regex(/^[0-9]{2}v[0-9](\.[0-9])?$/).nullable(), // e.g. "26v2"
  rollFiscalYear: z.number().int().min(2020).max(2100).nullable(), //       the DOF roll the market-value fact uses
  datasets,
})
export type Sources = z.infer<typeof SourcesSchema>

export const GateCheckSchema = z.strictObject({ key: z.enum(GATE_KEYS), value: z.number().finite(), pass: z.boolean() })

// The model version shows on the public status page, so it's a short code, never text.
export const MODEL_VERSION = /^[a-z0-9][a-z0-9._-]{0,39}$/
// Run dates that make sense (engineering precaution): values as of 2026 or later,
// built on data that ends on or before the as-of day and at most 62 days before it.
export const FIRST_AS_OF = '2026-01-01'
export const MAX_DATA_LAG_DAYS = 62
const daysBetween = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000

export const RunSchema = z
  .strictObject({
    runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{7,63}$/),
    runAt: z.iso.datetime({ offset: true }), // checked against this server's clock: runTimeProblems
    asOf: isoDate,
    dataThrough: isoDate,
    modelVersion: z.string().regex(MODEL_VERSION),
    gates: z.strictObject({ passed: z.boolean(), checks: z.array(GateCheckSchema).length(GATE_KEYS.length) }),
    metrics: numberTree,
    scoreboard: numberTree.nullable(),
    sources: SourcesSchema.nullable(),
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
  .superRefine((r, ctx) => {
    const fail = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message })
    if (r.asOf < FIRST_AS_OF) fail('asOf', `before ${FIRST_AS_OF}`)
    if (r.dataThrough > r.asOf) fail('dataThrough', 'after asOf')
    else if (daysBetween(r.dataThrough, r.asOf) > MAX_DATA_LAG_DAYS) fail('dataThrough', `more than ${MAX_DATA_LAG_DAYS} days before asOf`)
    if (GATE_KEYS.some(k => r.gates.checks.filter(c => c.key === k).length !== 1)) fail('gates', 'each of the four gates exactly once')
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

// A run's times against this server's clock (engineering precaution): run time no
// more than 10 minutes ahead or 7 days back (a far-future time would stay "latest"
// for good), and an as-of day no later than tomorrow (UTC).
export const MAX_RUN_AHEAD_MS = 10 * 60_000
export const MAX_RUN_AGE_MS = 7 * 24 * 60 * 60_000
export function runTimeProblems(run: Pick<ValuationRunInput, 'runAt' | 'asOf'>, now: Date): string[] {
  const out: string[] = []
  const runAt = Date.parse(run.runAt)
  if (runAt > now.getTime() + MAX_RUN_AHEAD_MS) out.push('run.runAt: more than 10 minutes ahead of this server')
  if (runAt < now.getTime() - MAX_RUN_AGE_MS) out.push('run.runAt: more than 7 days ago')
  if (run.asOf > new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10)) out.push('run.asOf: later than tomorrow (UTC)')
  return out
}

// Every sale a row cites must be earlier than its run's as-of day: the values use
// earlier sales only (Brief 44 §5).
export function rowDateProblems(rows: ValuationRow[], asOf: string, limit = 20): string[] {
  const out: string[] = []
  rows.forEach((r, i) => {
    if (r.facts?.lastSale && r.facts.lastSale.date >= asOf) out.push(`rows.${i}.facts.lastSale.date: on or after the run's asOf`)
    r.comps.forEach((c, j) => {
      if (c.date >= asOf) out.push(`rows.${i}.comps.${j}.date: on or after the run's asOf`)
    })
  })
  return out.slice(0, limit)
}

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

// Where a payload was refused, never what it held: zod's own message for an unknown
// key would name it, so that one says only how many (the number trees and dataset
// ids never put a key they were sent into a path or a message).
export function issueList(error: z.ZodError, limit = 20): string[] {
  return error.issues.slice(0, limit).map(i => {
    const where = i.path.join('.') || '(root)'
    return i.code === 'unrecognized_keys' ? `${where}: unknown field (${i.keys.length})` : `${where}: ${i.message}`
  })
}
