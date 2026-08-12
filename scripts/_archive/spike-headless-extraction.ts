// scripts/spike-headless-extraction.ts
//
// Brief 1.6 spike — Compare API tool_use extraction vs Claude Code headless CLI
// extraction on a stratified 5-email cohort.
//
// Mode: comparison only. NO DB writes. NO production code path mutation.
// Default behavior is --dry-run (cohort enumeration only). Requires explicit
// --confirm to actually run extractions.
//
// Hard cost cap on the API arm via --max-api-cost USD (default $0.25).
//
// Usage:
//   npx tsx scripts/spike-headless-extraction.ts --dry-run
//   npx tsx scripts/spike-headless-extraction.ts --confirm
//   npx tsx scripts/spike-headless-extraction.ts --confirm --limit 5 --max-api-cost 0.25
import 'dotenv/config'
process.env.INGEST_V2 = 'true'

import { writeFileSync } from 'node:fs'
import { prisma } from '../lib/prisma'
import { getCurrentOrgId } from '../lib/auth/orgContext'
import { Category } from '@prisma/client'
import { EXTRACTION_SPEC_BY_CATEGORY } from '../lib/extraction/schemas'
import { extractWithSonnet } from '../lib/extraction/sonnetExtractor'
import { extractWithSonnetHeadless } from '../lib/extraction/sonnetExtractorHeadless'

// ── Arg parsing (mirrors scripts/catchup-v2-extract.ts) ──────────────────────
const argv = process.argv.slice(2)
function flagValue(name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const DRY_RUN      = argv.includes('--dry-run')
const CONFIRM      = argv.includes('--confirm')
const LIMIT        = flagValue('--limit')        ? parseInt(flagValue('--limit')!, 10)        : 5
const MAX_API_COST = flagValue('--max-api-cost') ? parseFloat(flagValue('--max-api-cost')!)   : 0.25
const REPORT_PATH  = flagValue('--report')       ?? '/tmp/headless_spike_report.json'

if (!DRY_RUN && !CONFIRM) {
  console.error('Refusing to run without --dry-run or --confirm.')
  process.exit(1)
}

// ── Cohort target: stratified by category ────────────────────────────────────
// 2 single-listing sale + 1 single-listing rental/active + 1 demand-side + 1 hotsheet
// We pick from already-V2-extracted emails so we know they have chunks AND
// a known-good API extraction already exists (we don't need to compare against
// the DB — both arms run live — but having chunks is a precondition).
const STRATA: { category: Category; want: number }[] = [
  { category: Category.COMING_SOON_SALE,    want: 2 },
  { category: Category.ACTIVE_SALE_LISTING, want: 1 },
  { category: Category.BUYER_ISO,           want: 1 },
  // Hotsheet stress case — high-cardinality multi-listing
  // (Note: HOTSHEET isn't in the Category enum; we use the most hotsheet-like
  // active category instead. Adjust based on what's in the live DB.)
  { category: Category.OPEN_HOUSE,          want: 1 },
]

interface Candidate {
  id:               string
  subject:          string
  senderName:       string | null
  senderEmail:      string | null
  receivedDateTime: Date
  category:         string
  chunkCount:       number
}

async function buildCohort(organizationId: string): Promise<Candidate[]> {
  const out: Candidate[] = []
  for (const { category, want } of STRATA) {
    const rows = await prisma.rawEmail.findMany({
      where: {
        organizationId,
        classifierCategory: category,
        opportunities: { some: { processingStatus: 'active' } },
      },
      select: {
        id: true, subject: true, senderName: true, senderEmail: true,
        receivedDateTime: true, classifierCategory: true,
      },
      orderBy: { receivedDateTime: 'desc' },
      take: want * 3,
    })
    if (rows.length === 0) continue
    // NOTE (Brief 1.6 executor): the brief's draft selected
    //   _count: { select: { documentChunks: true } }
    // but RawEmail has no `documentChunks` relation in the current schema
    // (DocumentChunk carries a scalar `parentEmailId` with no back-relation).
    // We count chunks per email via groupBy instead — the exact pattern in
    // scripts/catchup-v2-extract.ts. Cohort semantics are unchanged: only
    // emails with > 0 chunks qualify (chunks are a precondition for buildContext).
    const ids = rows.map(r => r.id)
    const chunkCounts = await prisma.documentChunk.groupBy({
      by:     ['parentEmailId'],
      where:  { organizationId, parentEmailId: { in: ids } },
      _count: { _all: true },
    })
    const chunkMap = new Map(chunkCounts.map(c => [c.parentEmailId, c._count._all]))
    const filtered = rows.filter(r => (chunkMap.get(r.id) ?? 0) > 0).slice(0, want)
    for (const r of filtered) {
      out.push({
        id: r.id, subject: r.subject,
        senderName: r.senderName, senderEmail: r.senderEmail,
        receivedDateTime: r.receivedDateTime,
        category: r.classifierCategory ?? '',
        chunkCount: chunkMap.get(r.id) ?? 0,
      })
    }
  }
  return out.slice(0, LIMIT)
}

// ── Local buildContext (copy of lib/extraction/extractEmailV2.ts:47 buildContext).
// We duplicate rather than export to keep production code unchanged for the spike.
// Update this if the source diverges.
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

// ── Diff logic ────────────────────────────────────────────────────────────────
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

function normalizeAddress(a: string | null): string {
  return (a ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/[.,]/g, '').trim()
}

function priceWithinTolerance(p1: number | null, p2: number | null, tol = 0.05): boolean {
  if (p1 == null && p2 == null) return true
  if (p1 == null || p2 == null) return false
  if (p1 === 0 && p2 === 0)     return true
  return Math.abs(p1 - p2) / Math.max(p1, p2) <= tol
}

function diffRecords(api: ExtractedRecordLite[], cli: ExtractedRecordLite[]): {
  countDelta:  number
  fieldMatches: { address: number; price: number; beds: number; category: number }
  perRecord:    Array<{ idx: number; addrMatch: boolean; priceMatch: boolean; bedsMatch: boolean; catMatch: boolean }>
} {
  const minLen = Math.min(api.length, cli.length)
  const perRecord: Array<{ idx: number; addrMatch: boolean; priceMatch: boolean; bedsMatch: boolean; catMatch: boolean }> = []
  let addrM = 0, priceM = 0, bedsM = 0, catM = 0
  for (let i = 0; i < minLen; i++) {
    const a = api[i]
    const c = cli[i]
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
    countDelta: cli.length - api.length,
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
  console.log('Brief 1.6 spike — API tool_use vs Claude Code headless CLI')
  console.log(`  mode:         ${DRY_RUN ? 'DRY-RUN' : 'LIVE'}`)
  console.log(`  limit:        ${LIMIT}`)
  console.log(`  max-api-cost: $${MAX_API_COST}`)
  console.log(`  report:       ${REPORT_PATH}`)
  console.log('═══════════════════════════════════════════════════════════════════')

  const cohort = await buildCohort(organizationId)
  console.log(`\nCohort selected: ${cohort.length} emails`)
  for (const c of cohort) {
    console.log(`  • ${c.id} [${c.category}] chunks=${c.chunkCount} — ${c.subject.slice(0, 70)}`)
  }

  if (DRY_RUN) {
    console.log('\nDRY RUN — no LLM calls made. Re-run with --confirm to execute.')
    await prisma.$disconnect()
    return
  }

  if (cohort.length === 0) {
    console.error('Empty cohort. Adjust STRATA constants in the script.')
    await prisma.$disconnect()
    process.exit(1)
  }

  type PerEmail = {
    id:                string
    category:          string
    api:  { ok: boolean; durationMs: number; error: string | null; recordCount: number; records: ExtractedRecordLite[]; costUsd: number | null; usage: unknown }
    cli:  { ok: boolean; durationMs: number; error: string | null; recordCount: number; records: ExtractedRecordLite[]; usage: unknown }
    diff: ReturnType<typeof diffRecords> | null
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

    console.log(`\n── ${c.id} [${cat}] ──`)

    // API arm — abort if we'd exceed the API cost cap.
    if (apiCostAcc >= MAX_API_COST) {
      console.warn(`  API cost cap $${MAX_API_COST} already reached ($${apiCostAcc.toFixed(4)} spent). Skipping API arm.`)
    }

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
      : { data: null, toolInput: null, usage: null, error: 'skipped (cost cap)' }
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
    console.log(`  API: ok=${apiResult.data != null} ${apiMs}ms records=${apiRecords.length} cost=$${apiCost.toFixed(4)} ${apiResult.error ? `err=${apiResult.error.slice(0, 100)}` : ''}`)

    // CLI arm
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
    console.log(`  CLI: ok=${cliResult.data != null} ${cliMs}ms records=${cliRecords.length} ${cliResult.error ? `err=${cliResult.error.slice(0, 100)}` : ''}`)

    const diff = (apiResult.data && cliResult.data) ? diffRecords(apiRecords, cliRecords) : null
    if (diff) {
      console.log(`  Diff: countΔ=${diff.countDelta} addrM=${diff.fieldMatches.address}/${Math.min(apiRecords.length, cliRecords.length)} priceM=${diff.fieldMatches.price} bedsM=${diff.fieldMatches.beds} catM=${diff.fieldMatches.category}`)
    }

    report.push({
      id: c.id,
      category: c.category,
      api: { ok: apiResult.data != null, durationMs: apiMs, error: apiResult.error, recordCount: apiRecords.length, records: apiRecords, costUsd: apiCost, usage: apiResult.usage },
      cli: { ok: cliResult.data != null, durationMs: cliMs, error: cliResult.error, recordCount: cliRecords.length, records: cliRecords, usage: cliResult.usage },
      diff,
    })
  }

  const summary = {
    runStart:    runStart.toISOString(),
    runEnd:      new Date().toISOString(),
    cohortSize:  cohort.length,
    apiTotalCostUsd: apiCostAcc,
    apiPassed:   report.filter(r => r.api.ok).length,
    cliPassed:   report.filter(r => r.cli.ok).length,
    bothPassed:  report.filter(r => r.api.ok && r.cli.ok).length,
    perEmail:    report,
  }
  writeFileSync(REPORT_PATH, JSON.stringify(summary, null, 2))

  console.log('\n═══════════════════════════════════════════════════════════════════')
  console.log('Spike summary')
  console.log(`  cohort:      ${summary.cohortSize}`)
  console.log(`  API passed:  ${summary.apiPassed}/${summary.cohortSize}`)
  console.log(`  CLI passed:  ${summary.cliPassed}/${summary.cohortSize}`)
  console.log(`  Both passed: ${summary.bothPassed}/${summary.cohortSize}`)
  console.log(`  API cost:    $${summary.apiTotalCostUsd.toFixed(4)}`)
  console.log(`  Report:      ${REPORT_PATH}`)
  console.log('═══════════════════════════════════════════════════════════════════')

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('FATAL:', e)
  await prisma.$disconnect()
  process.exit(1)
})
