// scripts/spike-headless-extraction-phase2.ts
//
// Brief 1.7 — Phase 2 headless extraction spike. Builds on Brief 1.6's
// PASS verdict by deliberately stressing the high-cardinality case
// (≥15 records per email) plus medium- and low-cardinality regimes.
// Adds address normalization to the diff layer and per-call telemetry
// for sustained-run quota observation.
//
// Cohort: 20 emails total
//   - Tier A (high):   3 emails, ≥15 records each (the real hotsheet stress)
//   - Tier B (medium): 5 emails, 5-14 records each
//   - Tier C (low):   12 emails, 1-3 records each (Phase 1 regression check)
//
// Excludes any rawEmailId already tested in Phase 1
// (/tmp/headless_spike_report.json).
//
// NO DB writes. NO production code mutation. Default --dry-run. Hard caps:
//   - API spend:  $1.50 (--max-api-cost)
//   - Cohort:     20 emails (--limit at most 20)
//
// Usage:
//   npx tsx scripts/spike-headless-extraction-phase2.ts --dry-run
//   npx tsx scripts/spike-headless-extraction-phase2.ts --confirm
//   npx tsx scripts/spike-headless-extraction-phase2.ts --confirm --max-api-cost 1.50
import 'dotenv/config'
process.env.INGEST_V2 = 'true'

import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { prisma } from '../lib/prisma'
import { getCurrentOrgId } from '../lib/auth/orgContext'
import { EXTRACTION_SPEC_BY_CATEGORY } from '../lib/extraction/schemas'
import type { Category } from '@prisma/client'
import { extractWithSonnet } from '../lib/extraction/sonnetExtractor'
import { extractWithSonnetHeadless } from '../lib/extraction/sonnetExtractorHeadless'

// ── Arg parsing ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
function flagValue(name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const DRY_RUN      = argv.includes('--dry-run')
const CONFIRM      = argv.includes('--confirm')
const LIMIT        = Math.min(20, flagValue('--limit') ? parseInt(flagValue('--limit')!, 10) : 20)
const MAX_API_COST = Math.min(1.50, flagValue('--max-api-cost') ? parseFloat(flagValue('--max-api-cost')!) : 1.50)
const REPORT_JSON  = flagValue('--report-json') ?? '/tmp/headless_spike_phase2_report.json'
const REPORT_MD    = flagValue('--report-md')   ?? '/tmp/headless_spike_phase2_report.md'
const DECISION_MD  = flagValue('--decision')    ?? '/tmp/headless_spike_phase2_decision.md'

if (!DRY_RUN && !CONFIRM) {
  console.error('Refusing to run without --dry-run or --confirm.')
  process.exit(1)
}

// Output token ceiling we assume — we flag any CLI response within 80% of this
// as a truncation risk.
// PHASE 2 EXECUTOR UPDATE (per the brief's Step-0 instruction: "if Step 0 reveals
// the CLI uses a different default, update ASSUMED_OUTPUT_CEILING and document the
// source"): the CLI envelope's modelUsage["claude-sonnet-4-6"].maxOutputTokens is
// 32000 on Claude Code v2.1.152 (observed on the auth smoke call), so the CLI's
// per-call output ceiling is 32000, not the 16384 the brief assumed. Using 16384
// would false-flag CLI responses and could wrongly demote PASS→PARTIAL.
const ASSUMED_OUTPUT_CEILING = 32000
const TRUNCATION_RISK_THRESHOLD = 0.80

// ── Cohort selection by cardinality ──────────────────────────────────────────
interface Candidate {
  id:               string
  subject:          string
  senderName:       string | null
  senderEmail:      string | null
  receivedDateTime: Date
  category:         string
  chunkCount:       number
  apiBaselineCount: number  // how many records the API previously extracted
  tier:             'A' | 'B' | 'C'
}

async function loadPhase1ExcludeIds(): Promise<Set<string>> {
  const path = '/tmp/headless_spike_report.json'
  if (!existsSync(path)) return new Set()
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { perEmail?: Array<{ id: string }> }
    return new Set((raw.perEmail ?? []).map(p => p.id))
  } catch {
    return new Set()
  }
}

async function buildCohort(organizationId: string): Promise<Candidate[]> {
  const excludeIds = await loadPhase1ExcludeIds()

  // Aggregate cardinality per email.
  const groups = await prisma.extractedOpportunity.groupBy({
    by: ['rawEmailId'],
    where: { organizationId, processingStatus: 'active' },
    _count: { _all: true },
  })
  const filteredRaw = groups
    .filter(g => !excludeIds.has(g.rawEmailId))
    .map(g => ({ rawEmailId: g.rawEmailId, count: g._count._all }))

  // PHASE 2 EXECUTOR DIVERGENCE (documented in /tmp/spike_phase2_cardinality.md):
  // Pre-filter to chunk-bearing emails BEFORE stratifying. Step 0 found the #1
  // cardinality email (a 9061-record "StreetEasy Daily Hotsheet") has 0 chunks;
  // the brief slices top-3-by-count FIRST, then drops chunkless rows during
  // hydration, which would leave Tier A at 2 instead of 3. Pre-filtering keeps
  // each tier at its intended size and drops non-extractable emails up front.
  const allCandidateIds = filteredRaw.map(g => g.rawEmailId)
  const cohortChunkAgg = await prisma.documentChunk.groupBy({
    by: ['parentEmailId'],
    where: { organizationId, parentEmailId: { in: allCandidateIds } },
    _count: { _all: true },
  })
  const chunkBearing = new Set(cohortChunkAgg.filter(c => c._count._all > 0).map(c => c.parentEmailId))
  const filtered = filteredRaw.filter(g => chunkBearing.has(g.rawEmailId))

  // Stratify. Adjust thresholds if supply is thin (see Step 0).
  let highMin = 15, midMin = 5, midMax = 14
  let tierA = filtered.filter(g => g.count >= highMin).sort((a, b) => b.count - a.count).slice(0, 3)
  if (tierA.length < 3) {
    highMin = 10
    tierA = filtered.filter(g => g.count >= highMin).sort((a, b) => b.count - a.count).slice(0, 3)
  }
  if (tierA.length < 3) {
    // Absolute top 3 regardless.
    tierA = filtered.sort((a, b) => b.count - a.count).slice(0, 3)
    console.warn(`  ! Tier A short on supply; using top ${tierA.length} regardless of threshold.`)
  }

  let tierB = filtered
    .filter(g => g.count >= midMin && g.count <= midMax && !tierA.find(a => a.rawEmailId === g.rawEmailId))
    .sort(() => Math.random() - 0.5)
    .slice(0, 5)
  if (tierB.length < 5) {
    midMin = 3
    tierB = filtered
      .filter(g => g.count >= midMin && g.count <= midMax && !tierA.find(a => a.rawEmailId === g.rawEmailId))
      .sort(() => Math.random() - 0.5)
      .slice(0, 5)
    if (tierB.length < 5) console.warn(`  ! Tier B short on supply; widened to ${midMin}+.`)
  }

  const tierC = filtered
    .filter(g => g.count <= 3 && !tierA.find(a => a.rawEmailId === g.rawEmailId) && !tierB.find(b => b.rawEmailId === g.rawEmailId))
    .sort(() => Math.random() - 0.5)
    .slice(0, 12)

  const all = [
    ...tierA.map(g => ({ ...g, tier: 'A' as const })),
    ...tierB.map(g => ({ ...g, tier: 'B' as const })),
    ...tierC.map(g => ({ ...g, tier: 'C' as const })),
  ].slice(0, LIMIT)

  // Hydrate
  const ids = all.map(g => g.rawEmailId)
  const rows = await prisma.rawEmail.findMany({
    where: { organizationId, id: { in: ids } },
    select: {
      id: true, subject: true, senderName: true, senderEmail: true,
      receivedDateTime: true, classifierCategory: true,
      // PHASE 2 EXECUTOR FIX: the brief's `_count: { select: { documentChunks: true } } as never`
      // type-checks (the `as never` suppresses it) but throws PrismaClientValidationError at
      // runtime — documentChunks is not a relation on RawEmail (DocumentChunk carries a scalar
      // parentEmailId with no back-relation). Removed; the chunk count comes from the groupBy below.
    },
  })
  // documentChunks is not a Prisma relation on RawEmail in this schema;
  // count via a separate groupBy (mirrors the Phase 1 script's pattern).
  const chunkCounts = await prisma.documentChunk.groupBy({
    by: ['parentEmailId'],
    where: { organizationId, parentEmailId: { in: ids } },
    _count: { _all: true },
  })
  const chunkMap = new Map(chunkCounts.map(c => [c.parentEmailId, c._count._all]))

  const rowMap = new Map(rows.map(r => [r.id, r]))
  return all
    .map(g => {
      const r = rowMap.get(g.rawEmailId)
      if (!r) return null
      const chunkCount = chunkMap.get(g.rawEmailId) ?? 0
      if (chunkCount === 0) return null  // can't run extraction without chunks
      return {
        id: r.id, subject: r.subject,
        senderName: r.senderName, senderEmail: r.senderEmail,
        receivedDateTime: r.receivedDateTime,
        category: r.classifierCategory ?? '',
        chunkCount,
        apiBaselineCount: g.count,
        tier: g.tier,
      } as Candidate
    })
    .filter((x): x is Candidate => x != null)
}

// ── Local buildContext (copy from extractEmailV2.ts; same as Phase 1) ────────
interface ChunkRow {
  chunkType:              string
  content:                string
  pageNumber:             number | null
  sectionHeading:         string | null
  hasTable:               boolean
  parentAttachmentId:     string | null
  parentLinkedResourceId: string | null
}
const MAX_CONTEXT_CHARS = 60_000

function buildContext(
  email: { subject: string; senderName: string | null; senderEmail: string | null; receivedDateTime: Date },
  chunks: ChunkRow[],
  attachmentNames: Map<string, string>,
  linkedUrls: Map<string, string>,
): { text: string; truncated: boolean } {
  const parts: string[] = []
  parts.push(
    `Subject: ${email.subject}`,
    `From: ${email.senderName ?? 'Unknown'} <${email.senderEmail ?? ''}>`,
    `Received: ${email.receivedDateTime.toISOString()}`,
  )
  const byType = (t: string) => chunks.filter(c => c.chunkType === t)
  const body = byType('email_body')
  if (body.length) { parts.push('\n=== EMAIL BODY ==='); for (const c of body) parts.push(c.content) }
  const linked = byType('linked_html')
  if (linked.length) {
    const groups = new Map<string, ChunkRow[]>()
    for (const c of linked) {
      const key = c.parentLinkedResourceId ?? '(unknown)'
      ;(groups.get(key) ?? groups.set(key, []).get(key)!).push(c)
    }
    for (const [resId, list] of groups) {
      const url = linkedUrls.get(resId) ?? 'linked page'
      parts.push(`\n=== LINKED PAGE: ${url} ===`)
      for (const c of list) parts.push(c.content)
    }
  }
  const pdf = chunks.filter(c => c.chunkType === 'pdf_text' || c.chunkType === 'pdf_table')
  if (pdf.length) {
    const groups = new Map<string, ChunkRow[]>()
    for (const c of pdf) {
      const key = c.parentAttachmentId ?? '(unknown)'
      ;(groups.get(key) ?? groups.set(key, []).get(key)!).push(c)
    }
    for (const [attId, list] of groups) {
      const name = attachmentNames.get(attId) ?? 'attachment'
      parts.push(`\n=== ATTACHMENT: ${name} ===`)
      for (const c of list) {
        const label = [
          c.pageNumber != null ? `page ${c.pageNumber}` : null,
          c.chunkType === 'pdf_table' ? 'table' : null,
          c.sectionHeading,
        ].filter(Boolean).join(' · ')
        parts.push(label ? `[${label}]\n${c.content}` : c.content)
      }
    }
  }
  const images = byType('inline_image')
  if (images.length) {
    parts.push('\n=== INLINE IMAGES (vision captions) ===')
    for (const c of images) {
      const label = c.sectionHeading ? `[${c.sectionHeading}]` : ''
      parts.push(`${label}${label ? '\n' : ''}${c.content}`)
    }
  }
  let text = parts.join('\n')
  let truncated = false
  if (text.length > MAX_CONTEXT_CHARS) {
    text = text.slice(0, MAX_CONTEXT_CHARS) + `\n\n[... truncated ${text.length - MAX_CONTEXT_CHARS} chars]`
    truncated = true
  }
  return { text, truncated }
}

async function buildUserMessage(c: Candidate, organizationId: string): Promise<string> {
  const chunks = await prisma.documentChunk.findMany({
    where:   { organizationId, parentEmailId: c.id },
    orderBy: [{ chunkType: 'asc' }, { pageNumber: 'asc' }, { createdAt: 'asc' }],
    select: {
      chunkType: true, content: true, pageNumber: true, sectionHeading: true,
      hasTable: true, parentAttachmentId: true, parentLinkedResourceId: true,
    },
  })
  const [linkedResources, attachments] = await Promise.all([
    prisma.linkedResource.findMany({ where: { organizationId, parentEmailId: c.id }, select: { id: true, url: true } }),
    prisma.attachment.findMany({ where: { organizationId, rawEmailId: c.id }, select: { id: true, name: true } }),
  ])
  const linkedUrls = new Map(linkedResources.map(r => [r.id, r.url]))
  const attachmentNames = new Map(attachments.map(a => [a.id, a.name]))
  const { text } = buildContext(
    { subject: c.subject, senderName: c.senderName, senderEmail: c.senderEmail, receivedDateTime: c.receivedDateTime },
    chunks, attachmentNames, linkedUrls,
  )
  return `Extract all relevant records from this email. The content below is assembled from the email body, any linked pages, attachment text/tables, and inline-image vision captions.\n\n${text}`
}

// ── Address normalization (Phase 2 hardening) ────────────────────────────────
function normalizeAddress(a: string | null): string {
  if (!a) return ''
  let s = a.toLowerCase().replace(/\s+/g, ' ').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim()
  // Drop trailing zip codes (5-digit or 5+4)
  s = s.replace(/\s+\d{5}(-\d{4})?\s*$/, '')
  // Drop trailing ", NY" / "NY" / state abbreviations (after zip is gone)
  s = s.replace(/\s+(ny|new york state|n y)\s*$/, '')
  // Drop trailing city names (NYC boroughs and common adjacents)
  const cities = [
    'new york', 'manhattan', 'brooklyn', 'queens', 'bronx', 'staten island',
    'long island', 'hoboken', 'jersey city', 'newark', 'yonkers',
  ]
  for (const c of cities) {
    s = s.replace(new RegExp(`\\s+${c}\\s*$`), '')
  }
  // Street suffix normalization
  const suffixes: Array<[RegExp, string]> = [
    [/\bavenue\b/g, 'ave'],
    [/\bave?\b/g, 'ave'],
    [/\bstreet\b/g, 'st'],
    [/\bstr\b/g, 'st'],
    [/\bst\b/g, 'st'],
    [/\bboulevard\b/g, 'blvd'],
    [/\bblvd\b/g, 'blvd'],
    [/\bplace\b/g, 'pl'],
    [/\bpl\b/g, 'pl'],
    [/\broad\b/g, 'rd'],
    [/\brd\b/g, 'rd'],
    [/\bdrive\b/g, 'dr'],
    [/\bdr\b/g, 'dr'],
    [/\blane\b/g, 'ln'],
    [/\bln\b/g, 'ln'],
    [/\bcourt\b/g, 'ct'],
    [/\bct\b/g, 'ct'],
    [/\bterrace\b/g, 'ter'],
    [/\bparkway\b/g, 'pkwy'],
  ]
  for (const [re, rep] of suffixes) s = s.replace(re, rep)
  // Directional words
  s = s.replace(/\bwest\b/g, 'w')
       .replace(/\beast\b/g, 'e')
       .replace(/\bnorth\b/g, 'n')
       .replace(/\bsouth\b/g, 's')
  // Apartment/unit indicator (PH = penthouse, # = unit number) — collapse whitespace around
  s = s.replace(/\s+#\s*/g, ' #').replace(/\bapt\b/g, '#').replace(/\bunit\b/g, '#')
  // Collapse remaining whitespace
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

function priceWithinTolerance(p1: number | null, p2: number | null, tol = 0.05): boolean {
  if (p1 == null && p2 == null) return true
  if (p1 == null || p2 == null) return false
  if (p1 === 0 && p2 === 0)     return true
  return Math.abs(p1 - p2) / Math.max(p1, p2) <= tol
}

// ── Records + diff ────────────────────────────────────────────────────────────
interface ExtractedRecordLite {
  category:         string | null
  address:          string | null
  neighborhood:     string | null
  price:            number | null
  minPrice:         number | null
  maxPrice:         number | null
  beds:             number | null
  baths:            number | null
  confidenceScore:  number | null
}

interface PerEmailDiff {
  countDelta:   number
  countDeltaPct: number   // |delta| / max(apiCount, 1)
  fieldMatches: { address: number; price: number; beds: number; category: number }
  perRecord:    Array<{ idx: number; addrMatch: boolean; priceMatch: boolean; bedsMatch: boolean; catMatch: boolean }>
}

function diffRecords(api: ExtractedRecordLite[], cli: ExtractedRecordLite[]): PerEmailDiff {
  const minLen = Math.min(api.length, cli.length)
  const perRecord: PerEmailDiff['perRecord'] = []
  let addrM = 0, priceM = 0, bedsM = 0, catM = 0
  for (let i = 0; i < minLen; i++) {
    const a = api[i], c = cli[i]
    const addrMatch  = normalizeAddress(a.address) === normalizeAddress(c.address)
    const priceMatch = priceWithinTolerance(a.price ?? a.minPrice ?? a.maxPrice, c.price ?? c.minPrice ?? c.maxPrice)
    const bedsMatch  = (a.beds ?? -1) === (c.beds ?? -1)
    const catMatch   = (a.category ?? '') === (c.category ?? '')
    if (addrMatch)  addrM++
    if (priceMatch) priceM++
    if (bedsMatch)  bedsM++
    if (catMatch)   catM++
    perRecord.push({ idx: i, addrMatch, priceMatch, bedsMatch, catMatch })
  }
  return {
    countDelta:   cli.length - api.length,
    countDeltaPct: api.length > 0 ? Math.abs(cli.length - api.length) / api.length : (cli.length > 0 ? 1 : 0),
    fieldMatches: { address: addrM, price: priceM, beds: bedsM, category: catM },
    perRecord,
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  for (const k of ['ANTHROPIC_API_KEY', 'DATABASE_URL']) {
    if (!process.env[k]) { console.error(`Missing env: ${k}`); process.exit(1) }
  }

  const organizationId = await getCurrentOrgId()
  const runStart = new Date()

  console.log('═══════════════════════════════════════════════════════════════════')
  console.log('Brief 1.7 — Phase 2 headless spike (cardinality stratified, 20-email)')
  console.log(`  mode:         ${DRY_RUN ? 'DRY-RUN' : 'LIVE'}`)
  console.log(`  limit:        ${LIMIT} (hard cap)`)
  console.log(`  max-api-cost: $${MAX_API_COST} (hard cap)`)
  console.log(`  reports:      ${REPORT_JSON} | ${REPORT_MD} | ${DECISION_MD}`)
  console.log('═══════════════════════════════════════════════════════════════════')

  const cohort = await buildCohort(organizationId)
  console.log(`\nCohort selected: ${cohort.length} emails`)
  const byTier = { A: 0, B: 0, C: 0 }
  for (const c of cohort) byTier[c.tier]++
  console.log(`  Tier A (high ≥15): ${byTier.A}`)
  console.log(`  Tier B (med 5-14): ${byTier.B}`)
  console.log(`  Tier C (low 1-3):  ${byTier.C}`)
  for (const c of cohort) {
    console.log(`    • [${c.tier}] ${c.id} api=${c.apiBaselineCount} chunks=${c.chunkCount} ${c.category} — ${c.subject.slice(0, 60)}`)
  }

  if (DRY_RUN) {
    console.log('\nDRY RUN — no LLM calls made. Re-run with --confirm to execute.')
    await prisma.$disconnect()
    return
  }

  if (cohort.length === 0) {
    console.error('Empty cohort. Phase 1 may have tested all extracted emails, or there are none.')
    await prisma.$disconnect()
    process.exit(1)
  }

  type PerCallTelemetry = { wallStartIso: string; durationMs: number; ok: boolean; error: string | null; stderrTail: string | null; usage: unknown }
  type PerEmail = {
    id:                string
    category:          string
    tier:              'A' | 'B' | 'C'
    apiBaselineCount:  number
    api:  { ok: boolean; durationMs: number; error: string | null; recordCount: number; records: ExtractedRecordLite[]; costUsd: number | null; usage: unknown; truncationRisk: boolean }
    cli:  { ok: boolean; durationMs: number; error: string | null; recordCount: number; records: ExtractedRecordLite[]; usage: unknown; truncationRisk: boolean; telemetry: PerCallTelemetry }
    diff: PerEmailDiff | null
    notes: string[]
  }
  const report: PerEmail[] = []
  let apiCostAcc = 0

  for (const c of cohort) {
    const userMessage = await buildUserMessage(c, organizationId)
    const cat = c.category as Category
    const spec = EXTRACTION_SPEC_BY_CATEGORY[cat]
    if (!spec) {
      console.warn(`  ! ${c.id}: no extraction spec for ${cat} — skipping`)
      continue
    }
    console.log(`\n── [${c.tier}] ${c.id} (api baseline=${c.apiBaselineCount}) [${cat}] ──`)
    const notes: string[] = []

    // API arm (skipped if cost cap reached)
    const apiT0 = Date.now()
    const apiResult = apiCostAcc < MAX_API_COST
      ? await extractWithSonnet({
          systemPrompt:    spec.systemPrompt,
          userMessage,
          toolName:        spec.toolName,
          toolDescription: spec.toolDescription,
          inputSchema:     spec.inputSchema,
          zodSchema:       spec.responseSchema,
        })
      : { data: null, toolInput: null, usage: null, error: 'skipped (cost cap reached)' }
    const apiMs = Date.now() - apiT0
    const apiRecords: ExtractedRecordLite[] = []
    if (apiResult.data) {
      const items = (apiResult.data as Record<string, unknown[]>)[spec.arrayKey] ?? []
      for (const item of items) {
        const ctx = { subject: c.subject, senderName: c.senderName, senderEmail: c.senderEmail }
        const row = spec.mapItem(item as never, ctx)
        apiRecords.push({
          category: row.category ?? null,
          address: row.address ?? null,
          neighborhood: row.neighborhood ?? null,
          price: row.price ?? null,
          minPrice: row.minPrice ?? null,
          maxPrice: row.maxPrice ?? null,
          beds: row.beds ?? null,
          baths: row.baths ?? null,
          confidenceScore: row.confidenceScore ?? null,
        })
      }
    }
    const apiCost = apiResult.usage
      ? apiResult.usage.inputTokens * (3.0 / 1_000_000) +
        apiResult.usage.outputTokens * (15.0 / 1_000_000) +
        apiResult.usage.cacheReadTokens * (0.30 / 1_000_000) +
        apiResult.usage.cacheCreationTokens * (3.75 / 1_000_000)
      : 0
    apiCostAcc += apiCost
    const apiTruncRisk = (apiResult.usage?.outputTokens ?? 0) >= ASSUMED_OUTPUT_CEILING * TRUNCATION_RISK_THRESHOLD
    console.log(`  API: ok=${apiResult.data != null} ${apiMs}ms records=${apiRecords.length} cost=$${apiCost.toFixed(4)} outTok=${apiResult.usage?.outputTokens ?? '?'} ${apiTruncRisk ? '[TRUNC RISK]' : ''} ${apiResult.error ? `err=${apiResult.error.slice(0, 80)}` : ''}`)
    if (apiTruncRisk) notes.push(`API output token count (${apiResult.usage?.outputTokens}) within ${(TRUNCATION_RISK_THRESHOLD*100).toFixed(0)}% of assumed ceiling (${ASSUMED_OUTPUT_CEILING})`)

    // CLI arm with telemetry
    const wallStart = new Date()
    const cliT0 = Date.now()
    const cliResult = await extractWithSonnetHeadless({
      systemPrompt:    spec.systemPrompt,
      userMessage,
      toolName:        spec.toolName,
      toolDescription: spec.toolDescription,
      inputSchema:     spec.inputSchema,
      zodSchema:       spec.responseSchema,
    })
    const cliMs = Date.now() - cliT0
    const cliRecords: ExtractedRecordLite[] = []
    if (cliResult.data) {
      const items = (cliResult.data as Record<string, unknown[]>)[spec.arrayKey] ?? []
      for (const item of items) {
        const ctx = { subject: c.subject, senderName: c.senderName, senderEmail: c.senderEmail }
        const row = spec.mapItem(item as never, ctx)
        cliRecords.push({
          category: row.category ?? null,
          address: row.address ?? null,
          neighborhood: row.neighborhood ?? null,
          price: row.price ?? null,
          minPrice: row.minPrice ?? null,
          maxPrice: row.maxPrice ?? null,
          beds: row.beds ?? null,
          baths: row.baths ?? null,
          confidenceScore: row.confidenceScore ?? null,
        })
      }
    }
    const cliOutTok = (cliResult.usage as { outputTokens?: number } | null)?.outputTokens ?? 0
    const cliTruncRisk = cliOutTok > 0 && cliOutTok >= ASSUMED_OUTPUT_CEILING * TRUNCATION_RISK_THRESHOLD
    const telemetry: PerCallTelemetry = {
      wallStartIso: wallStart.toISOString(),
      durationMs: cliMs,
      ok: cliResult.data != null,
      error: cliResult.error,
      stderrTail: null,  // adapter doesn't surface raw stderr; left null for future enhancement
      usage: cliResult.usage,
    }
    console.log(`  CLI: ok=${cliResult.data != null} ${cliMs}ms records=${cliRecords.length} outTok=${cliOutTok || '?'} ${cliTruncRisk ? '[TRUNC RISK]' : ''} ${cliResult.error ? `err=${cliResult.error.slice(0, 80)}` : ''}`)
    if (cliTruncRisk) notes.push(`CLI output token count (${cliOutTok}) within ${(TRUNCATION_RISK_THRESHOLD*100).toFixed(0)}% of assumed ceiling (${ASSUMED_OUTPUT_CEILING}) — possible truncation`)

    // Truncation heuristic: API extracted N records, CLI extracted <N/2 → flag.
    if (apiResult.data && cliResult.data && apiRecords.length >= 4 && cliRecords.length < apiRecords.length / 2) {
      notes.push(`Severe record-count drop: API extracted ${apiRecords.length}, CLI extracted ${cliRecords.length} — likely truncation or schema drift`)
    }

    const diff = (apiResult.data && cliResult.data) ? diffRecords(apiRecords, cliRecords) : null
    if (diff) {
      console.log(`  Diff: countΔ=${diff.countDelta} (${(diff.countDeltaPct * 100).toFixed(0)}%) addrM=${diff.fieldMatches.address}/${Math.min(apiRecords.length, cliRecords.length)} priceM=${diff.fieldMatches.price} bedsM=${diff.fieldMatches.beds} catM=${diff.fieldMatches.category}`)
    }

    report.push({
      id: c.id,
      category: c.category,
      tier: c.tier,
      apiBaselineCount: c.apiBaselineCount,
      api: { ok: apiResult.data != null, durationMs: apiMs, error: apiResult.error, recordCount: apiRecords.length, records: apiRecords, costUsd: apiCost, usage: apiResult.usage, truncationRisk: apiTruncRisk },
      cli: { ok: cliResult.data != null, durationMs: cliMs, error: cliResult.error, recordCount: cliRecords.length, records: cliRecords, usage: cliResult.usage, truncationRisk: cliTruncRisk, telemetry },
      diff,
      notes,
    })
  }

  // ── Summary + verdict ──────────────────────────────────────────────────────
  const tiers = { A: [] as PerEmail[], B: [] as PerEmail[], C: [] as PerEmail[] }
  for (const r of report) tiers[r.tier].push(r)

  function tierPass(arr: PerEmail[], maxCountDeltaPct = 0.10): { pass: number; total: number; cliPass: number; cliFail: PerEmail[] } {
    let pass = 0, cliPass = 0
    const cliFail: PerEmail[] = []
    for (const r of arr) {
      if (!r.cli.ok) { cliFail.push(r); continue }
      cliPass++
      if (!r.diff) continue
      if (r.diff.countDeltaPct <= maxCountDeltaPct) pass++
    }
    return { pass, total: arr.length, cliPass, cliFail }
  }
  const tA = tierPass(tiers.A, 0.10)
  const tB = tierPass(tiers.B, 0.10)
  const tC = tierPass(tiers.C, 0.10)

  const anyTruncationOnTierA = tiers.A.some(r => r.cli.truncationRisk)
  const summary = {
    runStart:    runStart.toISOString(),
    runEnd:      new Date().toISOString(),
    durationMs:  Date.now() - runStart.getTime(),
    cohortSize:  cohort.length,
    apiTotalCostUsd: apiCostAcc,
    tierCounts: { A: tiers.A.length, B: tiers.B.length, C: tiers.C.length },
    tierResults: { A: tA, B: tB, C: tC },
    anyTruncationOnTierA,
    truncationFlagged: report.filter(r => r.cli.truncationRisk).map(r => r.id),
    perEmail:    report,
  }
  writeFileSync(REPORT_JSON, JSON.stringify(summary, null, 2))

  console.log('\n═══════════════════════════════════════════════════════════════════')
  console.log('Phase 2 summary')
  console.log(`  cohort:      ${summary.cohortSize}`)
  console.log(`  duration:    ${(summary.durationMs / 1000).toFixed(1)}s`)
  console.log(`  API cost:    $${summary.apiTotalCostUsd.toFixed(4)}`)
  console.log(`  Tier A (high): CLI ok ${tA.cliPass}/${tA.total}, count-Δ within 10%: ${tA.pass}/${tA.total}`)
  console.log(`  Tier B (med):  CLI ok ${tB.cliPass}/${tB.total}, count-Δ within 10%: ${tB.pass}/${tB.total}`)
  console.log(`  Tier C (low):  CLI ok ${tC.cliPass}/${tC.total}, count-Δ within 10%: ${tC.pass}/${tC.total}`)
  console.log(`  Any Tier-A truncation flag: ${anyTruncationOnTierA}`)
  console.log(`  Reports:     ${REPORT_JSON} | ${REPORT_MD} | ${DECISION_MD}`)
  console.log('═══════════════════════════════════════════════════════════════════')

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('FATAL:', e)
  await prisma.$disconnect()
  process.exit(1)
})
