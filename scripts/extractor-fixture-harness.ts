// Brief 6.0 — Extractor fixture harness.
//
// Runs the V2 extraction path against the hand-crafted fixture set under
// test/fixtures/emails/ and produces an HONEST per-field accuracy report. This is
// a diagnostic, not a pass/fail gate — a category scoring 60% is a finding we log.
//
// Isolation: this never calls the gated production ingestion paths and never
// writes to Postgres/Qdrant. For each fixture it (1) runs the real gpt-4o-mini
// classifier, (2) mirrors production's needsDeepExtract gate, and (3) when
// warranted, assembles context with the real buildContext() and runs the real
// Sonnet extraction via runExtraction() — the exact functions extractEmailV2 uses.
// Attachments are supplied as pre-parsed text (the text a parser would yield);
// --attachments-live re-parses the small tagged PDF subset through real LlamaParse.
//
// Usage:
//   npx tsx scripts/extractor-fixture-harness.ts [--filter <category>] [--dry-run]
//        [--attachments-live] [--budget <usd>]
import 'dotenv/config'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Category } from '@prisma/client'
import { sourceClassifier } from '../lib/ingestion/sourceClassifier'
import type { ClassifierInput } from '../lib/ingestion/types'
import { EXTRACTION_SPEC_BY_CATEGORY } from '../lib/extraction/schemas'
import {
  buildContext,
  runExtraction,
  type ChunkRow,
  type RunExtractionResult,
} from '../lib/extraction/extractEmailV2'
import type { OppRowData } from '../lib/extraction/schemas'

// ── Config / args ────────────────────────────────────────────────────────────
const FIXTURE_ROOT = join(process.cwd(), 'test', 'fixtures', 'emails')
const ATTACHMENT_ROOT = join(process.cwd(), 'test', 'fixtures', 'attachments')
const REPORT_PATH = join(process.cwd(), 'test', 'fixtures', 'last-run-report.json')

const argv = process.argv.slice(2)
function flagValue(name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const FILTER = flagValue('--filter')?.toLowerCase()
const DRY_RUN = argv.includes('--dry-run')
const ATTACHMENTS_LIVE = argv.includes('--attachments-live')
const HARD_CAP_USD = flagValue('--budget') ? parseFloat(flagValue('--budget')!) : 10
// Rough gpt-4o-mini classifier cost per call (~900 in / ~60 out tokens).
const CLASSIFIER_COST = 900 * (0.15 / 1_000_000) + 60 * (0.60 / 1_000_000)

const PARTY_CATS = new Set<string>(['BUYER_ISO', 'RENTER_INQUIRY', 'SELLER_LEAD', 'LANDLORD_LEAD'])

// ── Fixture types ────────────────────────────────────────────────────────────
interface FixtureAttachment {
  filename: string
  mimeType: string
  parsedText?: string | null
  live?: boolean
  file?: string | null
}
interface Fixture {
  id: string
  notes?: string
  edgeCase?: boolean
  input: {
    subject: string
    from: { name?: string | null; email: string }
    receivedAt: string
    bodyText?: string | null
    bodyHtml?: string | null
    attachments?: FixtureAttachment[]
  }
  expected: {
    category: string
    address?: string | null
    neighborhood?: string | null
    borough?: string | null
    beds?: number | null
    price?: number | null
    propertyType?: string | null
    confidenceScoreMin?: number
    classificationReasonThemes?: string[]
    shouldExtractParty?: boolean
    expectedMultipleOpportunities?: number
  }
  __category: string   // dir name (lowercase)
  __path: string
}

// ── Load fixtures ────────────────────────────────────────────────────────────
function loadFixtures(): Fixture[] {
  const out: Fixture[] = []
  const dirs = readdirSync(FIXTURE_ROOT).filter(d => statSync(join(FIXTURE_ROOT, d)).isDirectory())
  for (const dir of dirs) {
    if (FILTER && dir !== FILTER) continue
    for (const f of readdirSync(join(FIXTURE_ROOT, dir)).filter(x => x.endsWith('.json'))) {
      const path = join(FIXTURE_ROOT, dir, f)
      const fx = JSON.parse(readFileSync(path, 'utf8')) as Fixture
      fx.__category = dir
      fx.__path = `${dir}/${f}`
      out.push(fx)
    }
  }
  return out.sort((a, b) => a.__path.localeCompare(b.__path))
}

// ── Text helpers ─────────────────────────────────────────────────────────────
function stripHtml(html: string): string {
  return html
    .replace(/<\s*(br|\/tr|\/p|\/div|\/li)\s*\/?\s*>/gi, '\n')
    .replace(/<\/td>\s*<td[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&gt;/gi, '>').replace(/&lt;/gi, '<')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function bodyForClassifier(fx: Fixture): string {
  const t = fx.input.bodyText?.trim()
  if (t) return t
  if (fx.input.bodyHtml) return stripHtml(fx.input.bodyHtml)
  return ''
}

// ── Build the extractor context from a fixture (mirrors what ingestEmailV2 would
//    have written as DocumentChunks), then reuse the real buildContext(). ──────
async function buildFixtureContext(fx: Fixture): Promise<string> {
  const chunks: ChunkRow[] = []
  const attachmentNames = new Map<string, string>()

  const bodyParts: string[] = []
  if (fx.input.bodyText?.trim()) bodyParts.push(fx.input.bodyText.trim())
  if (fx.input.bodyHtml) bodyParts.push(stripHtml(fx.input.bodyHtml))
  if (bodyParts.length) {
    chunks.push({
      chunkType: 'email_body', content: bodyParts.join('\n\n'),
      pageNumber: null, sectionHeading: null, hasTable: false,
      parentAttachmentId: null, parentLinkedResourceId: null,
    })
  }

  let attIdx = 0
  for (const att of fx.input.attachments ?? []) {
    attIdx++
    const attId = `fixatt-${attIdx}`
    const mime = (att.mimeType ?? '').toLowerCase()

    // Resolve the text the extractor would see for this attachment.
    let text = att.parsedText ?? ''
    if (ATTACHMENTS_LIVE && att.live === true && att.file && mime === 'application/pdf') {
      try {
        const { parsePdf } = await import('../lib/parsing/llamaParse')
        const bytes = readFileSync(join(ATTACHMENT_ROOT, att.file))
        const parsed = await parsePdf(bytes, att.filename)
        text = parsed.pages.map(p => p.text ?? '').join('\n\n').trim() || text
        console.log(`   · live-parsed ${att.filename}: ${text.length} chars from ${parsed.pages.length} page(s)`)
      } catch (e) {
        console.error(`   · live parse failed for ${att.filename}: ${(e as Error).message} — falling back to parsedText`)
      }
    }
    if (!text) continue

    if (mime.startsWith('image/')) {
      chunks.push({
        chunkType: 'inline_image', content: text,
        pageNumber: null, sectionHeading: att.filename, hasTable: false,
        parentAttachmentId: null, parentLinkedResourceId: null,
      })
    } else {
      // PDF / xlsx / docx → attachment text section (grouped by attachment name).
      attachmentNames.set(attId, att.filename)
      chunks.push({
        chunkType: 'pdf_text', content: text,
        pageNumber: null, sectionHeading: null, hasTable: /\|/.test(text),
        parentAttachmentId: attId, parentLinkedResourceId: null,
      })
    }
  }

  const { text } = buildContext(
    {
      subject: fx.input.subject,
      senderName: fx.input.from.name ?? null,
      senderEmail: fx.input.from.email ?? null,
      receivedDateTime: new Date(fx.input.receivedAt),
    },
    chunks,
    attachmentNames,
    new Map(),
  )
  return text
}

// ── Field diff rules ─────────────────────────────────────────────────────────
function norm(s: string): string {
  return s.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim()
}
// Full address normalization (directionals, street types, unit suffix). Applied
// ONLY as a fallback after a strict match fails, so any rescue is visible.
function normAddr(s: string): string {
  return norm(s)
    .replace(/#\s*[\w-]+/g, ' ')
    .replace(/\b(unit|apt|apartment|suite|ste)\s+[\w-]+/g, ' ')
    .replace(/\bstreet\b/g, 'st').replace(/\bavenue\b/g, 'ave')
    .replace(/\bplace\b/g, 'pl').replace(/\bboulevard\b/g, 'blvd')
    .replace(/\broad\b/g, 'rd').replace(/\bdrive\b/g, 'dr')
    .replace(/\blane\b/g, 'ln').replace(/\bterrace\b/g, 'ter')
    .replace(/\beast\b/g, 'e').replace(/\bwest\b/g, 'w')
    .replace(/\bnorth\b/g, 'n').replace(/\bsouth\b/g, 's')
    .replace(/\s+/g, ' ').trim()
}
const NBHD_ALIAS: Record<string, string> = {
  wv: 'west village', uws: 'upper west side', ues: 'upper east side',
  lic: 'long island city', les: 'lower east side', fidi: 'financial district',
  wburg: 'williamsburg', bk: 'brooklyn', hk: "hell's kitchen",
}
function normNbhd(s: string): string {
  const n = norm(s)
  return NBHD_ALIAS[n] ?? n
}
function stripArticle(s: string): string { return norm(s).replace(/^the\s+/, '') }

// Matchers return whether they matched and, if the match required normalization
// beyond a strict compare, a human-readable description of the rescue.
type MatchOut = { pass: boolean; normalized?: string }

function addrMatch(exp: string, act: string): MatchOut {
  const es = norm(exp), as = norm(act)
  if (es && as && (as.includes(es) || es.includes(as))) return { pass: true }
  const en = normAddr(exp), an = normAddr(act)
  if (en && an && (an.includes(en) || en.includes(an)))
    return { pass: true, normalized: `"${exp}" ~ "${act}" (normalized "${en}" ~ "${an}")` }
  return { pass: false }
}
function boroughMatch(exp: string, act: string): MatchOut {
  if (norm(exp) === norm(act)) return { pass: true }
  if (stripArticle(exp) === stripArticle(act))
    return { pass: true, normalized: `"${exp}" ~ "${act}" (article-stripped)` }
  return { pass: false }
}
function nbhdMatch(exp: string, act: string): MatchOut {
  if (norm(exp) === norm(act) || norm(act).includes(norm(exp))) return { pass: true }
  const en = normNbhd(exp)
  if (en === normNbhd(act) || norm(act).includes(en))
    return { pass: true, normalized: `"${exp}" ~ "${act}" (alias)` }
  return { pass: false }
}
function propTypeMatch(exp: string, act: string): MatchOut {
  return { pass: norm(exp) === norm(act) }
}

// Semantic-ish theme matching: literal → hyphen/space-insensitive → synonym.
// Anything matched beyond literal is reported as a normalization warning.
const THEME_SYNONYMS: Record<string, string[]> = {
  'coming soon': ['coming soon', 'pre-market', 'pre market', 'before it hits', 'not yet on market', 'before public', 'hitting the market', 'pre-launch', 'prelaunch', 'preview', 'ahead of', 'soon to', 'upcoming'],
  'off-market': ['off-market', 'off market', 'pocket', 'quietly', 'discreet', 'not publicly', 'privately', 'private listing'],
  'back on market': ['back on market', 'back on the market', 'returned to market', 're-listed', 'relisted', 'fell through', 'available again'],
  'development': ['development', 'new construction', 'new-construction', 'new dev', 'sponsor', 'building-level', 'offering plan', 'condominium', 'new building', 'sales gallery'],
  'rental': ['rental', 'rent', 'lease', 'per month', '/mo', 'monthly'],
  'sale': ['sale', 'for sale', 'selling', 'purchase'],
  'conversation': ['conversation', 'client', 'reply', 'thread', 'back-and-forth', 'correspondence', 'discussion', 'message', 'personal', 'inquiry'],
  'price': ['price', 'reduced', 'reduction', 'reprice', 'drop', 'lowered'],
  'buyer': ['buyer', 'buy', 'purchase', 'iso', 'looking for'],
  'single listing': ['single', 'one listing', 'a listing', 'individual unit'],
}
function themeFound(reason: string, theme: string): { found: boolean; via: 'literal' | 'normalized' | 'synonym' | 'none' } {
  const r = reason.toLowerCase()
  const t = theme.toLowerCase()
  if (r.includes(t)) return { found: true, via: 'literal' }
  const rn = r.replace(/[-\s]+/g, ' ')
  const tn = t.replace(/[-\s]+/g, ' ')
  if (rn.includes(tn)) return { found: true, via: 'normalized' }
  for (const s of THEME_SYNONYMS[t] ?? []) {
    if (rn.includes(s.replace(/[-\s]+/g, ' '))) return { found: true, via: 'synonym' }
  }
  return { found: false, via: 'none' }
}

// Known fixture ambiguities — surfaced in the report as 'ambiguous' (excluded from
// pass/fail), never silently passed and never used to edit a fixture (6.1 rule).
const AMBIGUOUS: { id: string; field: string; reason: string }[] = [
  { id: 'coming_soon_sale_04_astoria_two_family_htmltable', field: 'beds', reason: '2-family: 3 beds/unit vs 6 total — neither wrong' },
]

// Grader normalizations that rescued a strict-mismatch. Every entry is enumerated
// in the report so a real extraction bug can never hide behind normalization.
const NORMALIZATIONS: { id: string; field: string; detail: string }[] = []

type FieldStatus = 'pass' | 'fail' | 'ambiguous'
type FieldResult = { field: string; status: FieldStatus; expected: unknown; actual: unknown; note?: string; normalized?: string }

function gradeExtraction(fx: Fixture, ext: RunExtractionResult | null, predCategory: string, classifierConfidence: number): {
  fields: FieldResult[]
  extractionRan: boolean
} {
  const exp = fx.expected
  const fields: FieldResult[] = []
  const rows = ext?.rows ?? []
  const primary: OppRowData | undefined = rows[0]
  const extractionRan = ext != null && ext.error == null

  // Record a graded field. A failing field that is a known ambiguity becomes
  // 'ambiguous' (excluded from scoring). A passing field rescued by normalization
  // logs a warning to NORMALIZATIONS.
  function record(field: string, pass: boolean, expected: unknown, actual: unknown, normalized?: string, note?: string) {
    if (!pass) {
      const amb = AMBIGUOUS.find(a => a.id === fx.id && a.field === field)
      if (amb) { fields.push({ field, status: 'ambiguous', expected, actual, note: amb.reason }); return }
    }
    if (pass && normalized) NORMALIZATIONS.push({ id: fx.id, field, detail: normalized })
    fields.push({ field, status: pass ? 'pass' : 'fail', expected, actual, note, normalized: pass ? normalized : undefined })
  }

  // category — graded against classifier prediction (what production routes on).
  record('category', predCategory === exp.category, exp.category, predCategory)

  const isMulti = typeof exp.expectedMultipleOpportunities === 'number'
  if (isMulti) record('multipleOpportunities', rows.length === exp.expectedMultipleOpportunities, exp.expectedMultipleOpportunities, rows.length)

  const gradeScalars = extractionRan && !!primary && !isMulti

  function gradeStr(field: 'address' | 'neighborhood' | 'borough' | 'propertyType', matcher: (e: string, a: string) => MatchOut) {
    if (!(field in exp)) return
    const e = (exp as Record<string, unknown>)[field]
    if (!extractionRan || !primary) { record(field, false, e, '(no extraction)', undefined, 'not extracted'); return }
    const a = (primary as Record<string, unknown>)[field] as string | null
    if (e === null) { record(field, a == null || a === '', null, a); return }  // non-hallucination assertion
    if (a == null) { record(field, false, e, null); return }
    const out = matcher(String(e), String(a))
    record(field, out.pass, e, a, out.normalized)
  }

  if (isMulti) {
    if ('borough' in exp && exp.borough != null) gradeStr('borough', boroughMatch)
  } else if (gradeScalars) {
    gradeStr('address', addrMatch)
    gradeStr('neighborhood', nbhdMatch)
    gradeStr('borough', boroughMatch)
    gradeStr('propertyType', propTypeMatch)
    if ('beds' in exp && exp.beds != null) record('beds', primary!.beds === exp.beds, exp.beds, primary!.beds)
    if ('price' in exp && exp.price != null) {
      const a = primary!.price
      record('price', a != null && Math.abs(a - exp.price) <= 5000, exp.price, a)
    }
  } else if (!extractionRan) {
    for (const f of ['address', 'neighborhood', 'borough', 'beds', 'price', 'propertyType'] as const) {
      if (f in exp && (exp as Record<string, unknown>)[f] !== undefined) {
        record(f, false, (exp as Record<string, unknown>)[f], '(no extraction)', undefined, 'not extracted')
      }
    }
  }

  // confidenceScoreMin — extraction confidence if it ran, else classifier confidence.
  if (typeof exp.confidenceScoreMin === 'number') {
    const conf = extractionRan && primary ? primary.confidenceScore : classifierConfidence
    const src = extractionRan && primary ? 'extract' : 'classifier'
    record('confidenceScoreMin', conf >= exp.confidenceScoreMin, `>=${exp.confidenceScoreMin}`, `${conf?.toFixed?.(2) ?? conf} (${src})`)
  }

  // classificationReasonThemes — semantic containment; only when a reason exists.
  if (Array.isArray(exp.classificationReasonThemes) && exp.classificationReasonThemes.length && extractionRan && primary) {
    const reason = primary.classificationReason ?? ''
    const results = exp.classificationReasonThemes.map(t => ({ t, ...themeFound(reason, t) }))
    const missing = results.filter(r => !r.found).map(r => r.t)
    const viaNorm = results.filter(r => r.found && r.via !== 'literal')
    const normNote = viaNorm.length ? `themes matched semantically: ${viaNorm.map(v => `"${v.t}"(${v.via})`).join(', ')}` : undefined
    record('reasonThemes', missing.length === 0, exp.classificationReasonThemes,
      missing.length ? `missing: ${missing.join(', ')}` : 'all present', normNote)
  }

  // shouldExtractParty
  if (typeof exp.shouldExtractParty === 'boolean') {
    const actualParty = extractionRan && rows.some(r => (r.clientSide && r.clientSide.length > 0) || PARTY_CATS.has(r.category))
    record('shouldExtractParty', actualParty === exp.shouldExtractParty, exp.shouldExtractParty, actualParty)
  }

  return { fields, extractionRan }
}

// ── Main ─────────────────────────────────────────────────────────────────────
interface FixtureReport {
  id: string
  category: string
  edgeCase: boolean
  predictedCategory: string
  classifierConfidence: number
  extractionRan: boolean
  score: number       // fraction of graded fields passing
  graded: number
  passed: number
  costUsd: number
  fields: FieldResult[]
  error?: string | null
}

async function main() {
  const fixtures = loadFixtures()
  const stamp = new Date().toISOString()
  console.log('FIXTURE HARNESS RUN —', stamp)
  console.log('═'.repeat(75))
  console.log(`Fixtures loaded: ${fixtures.length}${FILTER ? ` (filter: ${FILTER})` : ''}`)
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (classifier only, no Sonnet)' : 'full extraction'}` +
    `${ATTACHMENTS_LIVE ? ' + attachments-live' : ''} | hard cap $${HARD_CAP_USD.toFixed(2)}\n`)

  const reports: FixtureReport[] = []
  let runningCost = 0
  let aborted = false

  for (const fx of fixtures) {
    const bodyText = bodyForClassifier(fx)
    const atts = fx.input.attachments ?? []
    const classifierInput: ClassifierInput = {
      rawEmailId: fx.id,
      subject: fx.input.subject,
      senderName: fx.input.from.name ?? null,
      senderEmail: fx.input.from.email ?? null,
      bodyPreview: bodyText.slice(0, 250) || null,
      bodyFirst500: bodyText.slice(0, 500) || null,
      attachmentNames: atts.map(a => a.filename),
      attachmentMimeTypes: atts.map(a => a.mimeType),
      attachmentCount: atts.length,
    }

    const cls = await sourceClassifier(classifierInput)
    runningCost += CLASSIFIER_COST
    const predCategory = cls.category
    const spec = (Object.values(Category) as string[]).includes(predCategory)
      ? EXTRACTION_SPEC_BY_CATEGORY[predCategory as Category]
      : null

    let ext: RunExtractionResult | null = null
    let fixtureCost = CLASSIFIER_COST

    const willExtract = !DRY_RUN && cls.needsDeepExtract && spec != null
    if (willExtract) {
      if (runningCost >= HARD_CAP_USD) {
        console.log(`\n⛔ HARD CAP $${HARD_CAP_USD} reached (running $${runningCost.toFixed(4)}). Stopping before ${fx.id}.`)
        aborted = true
        break
      }
      const context = await buildFixtureContext(fx)
      const ctx = { subject: fx.input.subject, senderName: fx.input.from.name ?? null, senderEmail: fx.input.from.email ?? null }
      ext = await runExtraction(spec!, context, ctx)
      const c = ext.costUsd ?? 0
      runningCost += c
      fixtureCost += c
    }

    const { fields, extractionRan } = gradeExtraction(fx, ext, predCategory, cls.confidence)
    const graded = fields.filter(f => f.status !== 'ambiguous').length   // ambiguities excluded
    const passed = fields.filter(f => f.status === 'pass').length
    const score = graded ? passed / graded : 1

    reports.push({
      id: fx.id, category: fx.__category, edgeCase: !!fx.edgeCase,
      predictedCategory: predCategory, classifierConfidence: cls.confidence,
      extractionRan, score, graded, passed, costUsd: fixtureCost,
      fields, error: ext?.error ?? null,
    })

    const catHit = predCategory === fx.expected.category ? '✓' : `✗→${predCategory}`
    console.log(
      `${(score * 100).toFixed(0).padStart(3)}%  ${fx.__path.padEnd(58)} ` +
      `cat:${catHit.padEnd(10)} ${passed}/${graded}f  $${fixtureCost.toFixed(4)}  Σ$${runningCost.toFixed(4)}`,
    )
    if (runningCost > HARD_CAP_USD) {
      console.log(`\n⛔ HARD CAP $${HARD_CAP_USD} exceeded (running $${runningCost.toFixed(4)}). Stopping.`)
      aborted = true
      break
    }
  }

  printSummary(reports, runningCost, aborted, stamp)
}

function printSummary(reports: FixtureReport[], runningCost: number, aborted: boolean, stamp: string) {
  // Per-category rollup
  const byCat = new Map<string, FixtureReport[]>()
  for (const r of reports) (byCat.get(r.category) ?? byCat.set(r.category, []).get(r.category)!).push(r)

  console.log('\n' + '═'.repeat(75))
  console.log('CATEGORY-LEVEL ACCURACY')
  console.log('═'.repeat(75))
  const cats = [...byCat.keys()].sort()
  for (const cat of cats) {
    const rs = byCat.get(cat)!
    const classifierHits = rs.filter(r => reportCategoryHit(r)).length
    const fieldAcc = rs.reduce((s, r) => s + r.score, 0) / rs.length
    const cost = rs.reduce((s, r) => s + r.costUsd, 0)
    console.log(
      `  ${cat.toUpperCase().padEnd(24)} ${classifierHits}/${rs.length} classified | ` +
      `${(fieldAcc * 100).toFixed(0)}% field acc | $${(cost / rs.length).toFixed(4)}/fx`,
    )
  }

  // Field-level failures (only real 'fail' status — ambiguities are separate)
  console.log('\n' + '═'.repeat(75))
  console.log('FIXTURES WITH FIELD FAILURES')
  console.log('═'.repeat(75))
  const imperfect = reports.filter(r => r.fields.some(f => f.status === 'fail')).sort((a, b) => a.score - b.score)
  for (const r of imperfect) {
    const fails = r.fields.filter(f => f.status === 'fail')
    console.log(`  ${(r.score * 100).toFixed(0).padStart(3)}%  ${r.id}${r.edgeCase ? ' [edge]' : ''}`)
    for (const f of fails) {
      console.log(`         ${f.field}: expected ${JSON.stringify(f.expected)} | actual ${JSON.stringify(f.actual)}${f.note ? ` (${f.note})` : ''}`)
    }
  }
  if (!imperfect.length) console.log('  (none)')

  // Normalization warnings — strict mismatches the grader rescued. Enumerated so a
  // real extraction bug (wrong unit / wrong street) can't hide behind normalization.
  console.log('\n' + '═'.repeat(75))
  console.log(`NORMALIZATIONS — ${NORMALIZATIONS.length} strict mismatch(es) rescued by the grader`)
  console.log('═'.repeat(75))
  for (const n of NORMALIZATIONS) console.log(`  ~ ${n.id} · ${n.field}: ${n.detail}`)
  if (!NORMALIZATIONS.length) console.log('  (none)')

  // Fixture ambiguities — excluded from scoring, surfaced, never silently resolved.
  const ambiguities = reports.flatMap(r => r.fields.filter(f => f.status === 'ambiguous').map(f => ({ id: r.id, f })))
  console.log('\n' + '═'.repeat(75))
  console.log(`FIXTURE AMBIGUITIES — ${ambiguities.length} (excluded from scoring; neither wrong)`)
  console.log('═'.repeat(75))
  for (const { id, f } of ambiguities) {
    console.log(`  ? ${id} · ${f.field}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)} — ${f.note}`)
  }
  if (!ambiguities.length) console.log('  (none)')

  // Field aggregate (ambiguous excluded from denominator)
  const fieldAgg = new Map<string, { pass: number; total: number; norm: number }>()
  for (const r of reports) for (const f of r.fields) {
    if (f.status === 'ambiguous') continue
    const a = fieldAgg.get(f.field) ?? { pass: 0, total: 0, norm: 0 }
    a.total++; if (f.status === 'pass') a.pass++; if (f.normalized) a.norm++
    fieldAgg.set(f.field, a)
  }
  console.log('\n' + '═'.repeat(75))
  console.log('FIELD-LEVEL AGGREGATE (across all graded fixtures; * = # rescued by normalization)')
  console.log('═'.repeat(75))
  for (const [field, a] of [...fieldAgg.entries()].sort()) {
    console.log(`  ${field.padEnd(24)} ${a.pass}/${a.total}  (${((a.pass / a.total) * 100).toFixed(0)}%)${a.norm ? `  *${a.norm}` : ''}`)
  }

  const classifierHits = reports.filter(reportCategoryHit).length
  const overall = reports.length ? reports.reduce((s, r) => s + r.score, 0) / reports.length : 0
  console.log('\n' + '═'.repeat(75))
  console.log(`TOTAL FIXTURES:        ${reports.length}${aborted ? ' (ABORTED at budget cap)' : ''}`)
  console.log(`CLASSIFIER ACCURACY:   ${classifierHits}/${reports.length} (${((classifierHits / reports.length) * 100).toFixed(0)}%)`)
  console.log(`OVERALL FIELD ACC:     ${(overall * 100).toFixed(1)}%  (${NORMALIZATIONS.length} normalization rescues, ${ambiguities.length} ambiguities excluded)`)
  console.log(`TOTAL COST:            $${runningCost.toFixed(4)}`)
  console.log('═'.repeat(75))

  writeFileSync(REPORT_PATH, JSON.stringify({
    stamp, filter: FILTER ?? null, dryRun: DRY_RUN, attachmentsLive: ATTACHMENTS_LIVE,
    totalFixtures: reports.length, aborted, classifierHits, overallFieldAccuracy: overall,
    totalCostUsd: runningCost, normalizations: NORMALIZATIONS, ambiguities, reports,
  }, null, 2))
  console.log(`\nReport written to ${REPORT_PATH}`)
}

// classifier hit = predicted category equals the fixture's expected category
function reportCategoryHit(r: FixtureReport): boolean {
  const catField = r.fields.find(f => f.field === 'category')
  return catField?.status === 'pass'
}

main().catch(e => { console.error(e); process.exit(1) })
