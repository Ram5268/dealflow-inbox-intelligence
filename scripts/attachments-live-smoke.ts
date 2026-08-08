// Brief 6.1 Fix #3 — Live attachment smoke test.
//
// Proves the REAL binary path end-to-end for the 4 live PDF fixtures, before any
// real Outlook connection exists:
//   PDF bytes -> LlamaParse (agentic) -> Postgres DocumentChunks
//            -> extractEmailV2 (Sonnet) -> ExtractedOpportunity rows
// (Voyage/Qdrant were removed in the 6.1 addendum; chunks live in Postgres.)
//
// It seeds a throwaway RawEmail + Attachment per fixture, runs the real
// processAttachments() + extractEmailV2(), verifies the opportunities against the
// fixture's expectation, then TEARS DOWN everything it created (finally block).
// The seeded opportunities are isTestData=false, so TEST_MODE_ONLY chat (which
// only reads isTestData=true seed rows) never surfaces them even transiently.
//
// This deliberately runs the pipeline COMPONENTS directly; it does NOT go through
// the gated ingestEmailV2/sync path, and it re-verifies that the Outlook path is
// still blocked. Requires --yes-write-db (it writes to the live DB then cleans up).
//
//   npx tsx scripts/attachments-live-smoke.ts --yes-write-db
import 'dotenv/config'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { prisma } from '../lib/prisma'
import { getCurrentOrgId } from '../lib/auth/orgContext'
import { processAttachments } from '../lib/ingestion/processAttachments'
import { extractEmailV2 } from '../lib/extraction/extractEmailV2'
import { ingestEmailV2 } from '../lib/ingestion/ingestEmailV2'
import { isIngestionTestModeOnly } from '../lib/config/ingestionTestMode'

const FIXTURE_ROOT = join(process.cwd(), 'test', 'fixtures', 'emails')
const ATTACH_ROOT = join(process.cwd(), 'test', 'fixtures', 'attachments')
const GRAPH_PREFIX = 'fixture-live-smoke:'
const HARD_CAP_USD = 5

if (!process.argv.includes('--yes-write-db')) {
  console.log('This script writes throwaway rows to the LIVE DB (then deletes them).')
  console.log('Re-run with --yes-write-db to proceed.')
  process.exit(0)
}

interface LiveFixture {
  id: string
  category: string
  subject: string
  senderName: string | null
  senderEmail: string | null
  bodyText: string
  filename: string
  mimeType: string
  pdfBytes: Buffer
  expectedOpps: number       // expectedMultipleOpportunities or 1
  expectedBorough: string | null
}

function loadLiveFixtures(): LiveFixture[] {
  const out: LiveFixture[] = []
  for (const dir of readdirSync(FIXTURE_ROOT).filter(d => statSync(join(FIXTURE_ROOT, d)).isDirectory())) {
    for (const f of readdirSync(join(FIXTURE_ROOT, dir)).filter(x => x.endsWith('.json'))) {
      const fx = JSON.parse(readFileSync(join(FIXTURE_ROOT, dir, f), 'utf8'))
      for (const att of fx.input?.attachments ?? []) {
        if (att.live === true && att.file && (att.mimeType || '').toLowerCase() === 'application/pdf') {
          out.push({
            id: fx.id, category: fx.expected.category,
            subject: fx.input.subject,
            senderName: fx.input.from?.name ?? null,
            senderEmail: fx.input.from?.email ?? null,
            bodyText: fx.input.bodyText ?? '',
            filename: att.filename, mimeType: att.mimeType,
            pdfBytes: readFileSync(join(ATTACH_ROOT, att.file)),
            expectedOpps: typeof fx.expected.expectedMultipleOpportunities === 'number' ? fx.expected.expectedMultipleOpportunities : 1,
            expectedBorough: fx.expected.borough ?? null,
          })
        }
      }
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

async function teardown(orgId: string, rawEmailIds: string[]) {
  if (!rawEmailIds.length) return
  // Postgres-only cascade (Qdrant removed in the 6.1 addendum).
  await prisma.extractedOpportunity.deleteMany({ where: { organizationId: orgId, rawEmailId: { in: rawEmailIds } } }).catch(() => {})
  await prisma.reviewQueueItem.deleteMany({ where: { organizationId: orgId, rawEmailId: { in: rawEmailIds } } }).catch(() => {})
  await prisma.documentChunk.deleteMany({ where: { organizationId: orgId, parentEmailId: { in: rawEmailIds } } }).catch(() => {})
  await prisma.aIExtractionLog.deleteMany({ where: { organizationId: orgId, rawEmailId: { in: rawEmailIds } } }).catch(() => {})
  await prisma.attachment.deleteMany({ where: { organizationId: orgId, rawEmailId: { in: rawEmailIds } } }).catch(() => {})
  await prisma.rawEmail.deleteMany({ where: { id: { in: rawEmailIds } } }).catch(() => {})
}

interface PdfResult {
  id: string; category: string
  llamaParseOk: boolean; pages: number; chunks: number
  oppsExtracted: number; expectedOpps: number; boroughOk: boolean | null
  match: boolean; sonnetCostUsd: number; error?: string
}

async function main() {
  const orgId = await getCurrentOrgId()
  const fixtures = loadLiveFixtures()
  console.log('ATTACHMENTS-LIVE SMOKE TEST')
  console.log('═'.repeat(75))
  console.log(`Org: ${orgId}`)
  console.log(`Live PDF fixtures: ${fixtures.length}\n`)

  // Re-verify the gate: the real Outlook/sync path must stay blocked.
  const gateOn = isIngestionTestModeOnly()
  const gateProbe = await ingestEmailV2('gate-probe-nonexistent')
  const gateBlocks = gateProbe.errors.some(e => e.includes('INGESTION_TEST_MODE_ONLY'))
  console.log(`Gate check: INGESTION_TEST_MODE_ONLY=${gateOn} · ingestEmailV2 blocked=${gateBlocks} ` +
    `${gateOn && gateBlocks ? '✅' : '❌'}\n`)

  // Clean any stragglers from a prior aborted run.
  const prior = await prisma.rawEmail.findMany({ where: { graphMessageId: { startsWith: GRAPH_PREFIX } }, select: { id: true } })
  if (prior.length) { console.log(`Cleaning ${prior.length} straggler(s) from a prior run...`); await teardown(orgId, prior.map(p => p.id)) }

  const results: PdfResult[] = []
  const seeded: string[] = []

  try {
    for (const fx of fixtures) {
      let rawEmailId = ''
      try {
        const email = await prisma.rawEmail.create({
          data: {
            graphMessageId: `${GRAPH_PREFIX}${fx.id}`,
            subject: fx.subject, senderName: fx.senderName, senderEmail: fx.senderEmail,
            receivedDateTime: new Date('2026-08-01T12:00:00Z'),
            bodyContent: fx.bodyText, bodyContentType: 'text',
            classifierCategory: fx.category, classifierStatus: 'classified',
            organizationId: orgId,
          },
          select: { id: true },
        })
        rawEmailId = email.id
        seeded.push(rawEmailId)
        const att = await prisma.attachment.create({
          data: {
            rawEmailId, name: fx.filename, mimeType: fx.mimeType,
            sizeBytes: fx.pdfBytes.length, contentBytes: fx.pdfBytes, organizationId: orgId,
          },
          select: { id: true },
        })

        // Real production path: LlamaParse (agentic) -> Postgres DocumentChunks.
        // (Voyage/Qdrant were removed in the 6.1 addendum; the extractor reads
        // chunks straight from Postgres.)
        const pa = await processAttachments({ rawEmailId, threadId: null, organizationId: orgId })
        const cr = await prisma.documentChunk.findMany({
          where: { organizationId: orgId, parentEmailId: rawEmailId }, select: { pageNumber: true },
        })
        const chunkCount = cr.length
        const pages = new Set(cr.map(c => c.pageNumber).filter(p => p != null)).size
        const llamaParseOk = pa.attachmentsProcessed >= 1 && chunkCount > 0 && !pa.errors.some(e => /parsePdf|pdf /i.test(e))
        const chunkRows = { length: chunkCount }

        // 2) Real Sonnet extraction -> ExtractedOpportunity rows
        const opps = await extractEmailV2(rawEmailId, orgId)
        const log = await prisma.aIExtractionLog.aggregate({
          where: { organizationId: orgId, rawEmailId }, _sum: { estimatedCostUsd: true },
        })
        const sonnetCostUsd = log._sum.estimatedCostUsd ?? 0
        const boroughOk = fx.expectedBorough == null ? null
          : opps.some(o => (o.borough ?? '').toLowerCase().replace(/^the\s+/, '') === fx.expectedBorough!.toLowerCase().replace(/^the\s+/, ''))
        const oppsOk = opps.length === fx.expectedOpps
        results.push({
          id: fx.id, category: fx.category, llamaParseOk, pages, chunks: chunkRows.length,
          oppsExtracted: opps.length, expectedOpps: fx.expectedOpps,
          boroughOk, match: oppsOk && (boroughOk ?? true), sonnetCostUsd,
        })
        console.log(`  ${llamaParseOk ? '✅' : '❌'} ${fx.id.padEnd(46)} pages:${pages} chunks:${chunkRows.length} ` +
          `opps:${opps.length}/${fx.expectedOpps} $${sonnetCostUsd.toFixed(4)}`)
      } catch (e) {
        results.push({ id: fx.id, category: fx.category, llamaParseOk: false, pages: 0, chunks: 0, oppsExtracted: 0, expectedOpps: fx.expectedOpps, boroughOk: null, match: false, sonnetCostUsd: 0, error: (e as Error).message })
        console.log(`  ❌ ${fx.id}: ${(e as Error).message}`)
      }
    }
  } finally {
    console.log('\nTearing down seeded rows...')
    await teardown(orgId, seeded)
    const leftover = await prisma.rawEmail.count({ where: { graphMessageId: { startsWith: GRAPH_PREFIX } } })
    console.log(`Teardown complete. Remaining smoke-test rows: ${leftover} ${leftover === 0 ? '✅' : '❌'}`)
  }

  // Report
  const totalSonnet = results.reduce((s, r) => s + r.sonnetCostUsd, 0)
  console.log('\n' + '═'.repeat(75))
  console.log('LIVE PIPELINE RESULTS')
  console.log('═'.repeat(75))
  for (const r of results) {
    console.log(`  ${r.match ? '✅' : '⚠️ '} ${r.id}`)
    console.log(`       LlamaParse: ${r.llamaParseOk ? 'success' : 'FAILED'} | pages: ${r.pages} | chunks: ${r.chunks} | ` +
      `opps: ${r.oppsExtracted}/${r.expectedOpps}${r.boroughOk == null ? '' : ` | borough: ${r.boroughOk ? 'ok' : 'MISS'}`}${r.error ? ` | err: ${r.error}` : ''}`)
  }
  const allParsed = results.every(r => r.llamaParseOk)
  console.log('\n' + '═'.repeat(75))
  console.log(`LlamaParse round-trip: ${results.filter(r => r.llamaParseOk).length}/${results.length} ${allParsed ? '✅ all PDFs parsed' : '❌'}`)
  console.log(`Extraction match:      ${results.filter(r => r.match).length}/${results.length}`)
  console.log(`Sonnet cost:           $${totalSonnet.toFixed(4)} (LlamaParse billed externally; ~4 pages premium)`)
  console.log(`Hard cap:              $${HARD_CAP_USD} (Sonnet portion only measurable here)`)
  console.log('═'.repeat(75))
}

main()
  .catch(e => { console.error('FATAL:', e); process.exit(1) })
  .finally(() => prisma.$disconnect())
