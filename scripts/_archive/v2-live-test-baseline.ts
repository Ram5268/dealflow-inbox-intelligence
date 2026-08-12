import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { ingestEmailV2 } from '../lib/ingestion/ingestEmailV2'

// LIVE V2 TEST on the same failing emails analyzed by the live-baseline-json-object
// task. Resets embeddedAt to null per email, then invokes ingestEmailV2 with real
// service calls (LlamaParse, Firecrawl, Voyage, Claude vision). After ingestion,
// queries DocumentChunk and dumps byType counts + a 500-char sample per type.

const TARGETS: { id: string; label: string }[] = [
  { id: 'cmpxayoo80008h68oh3zmer89', label: "Donald Kemper — Spacious 1BR Hell's Kitchen $650K" },
  { id: 'cmpxaz04b000mh68oi5ezabc7', label: 'Monarch Realty — Fw: Current Listings (2 attachments)' },
  { id: 'cmpxb04go001kh68ovsgmpjr3', label: 'BLDG LISTINGS (1 attachment)' },
]

async function main() {
  process.env.INGEST_V2 = 'true'
  console.log('═══════════════════════════════════════════════════════════════════')
  console.log('LIVE V2 TEST on live-baseline-json-object failing cohort')
  console.log(`INGEST_V2=${process.env.INGEST_V2}`)
  console.log('═══════════════════════════════════════════════════════════════════\n')

  for (const t of TARGETS) {
    console.log('───────────────────────────────────────────────────────────────────')
    console.log(`▶ ${t.id}`)
    console.log(`  ${t.label}`)
    console.log('───────────────────────────────────────────────────────────────────')

    // Reset embeddedAt so V2's idempotency wipe runs cleanly
    await prisma.rawEmail.update({
      where: { id: t.id },
      data:  { embeddedAt: null },
    })
    console.log('  embeddedAt reset to null.')

    const t0 = Date.now()
    let result
    try {
      result = await ingestEmailV2(t.id)
    } catch (e) {
      console.log(`  ❌ ingestEmailV2 threw: ${(e as Error).stack ?? (e as Error).message}`)
      continue
    }
    const ms = Date.now() - t0

    console.log(`\n  ✔ Completed in ${ms}ms`)
    console.log(`  threadId             : ${result.threadId}`)
    console.log(`  chunksCreated        : ${result.chunksCreated}`)
    console.log(`  byType               : ${JSON.stringify(result.byType)}`)
    console.log(`  linksFound           : ${result.linksFound}`)
    console.log(`  linksScraped         : ${result.linksScraped}`)
    console.log(`  linksDeferred        : ${result.linksDeferred}`)
    console.log(`  linksFiltered        : ${result.linksFiltered}`)
    console.log(`  imagesProcessed      : ${result.imagesProcessed}`)
    console.log(`  imagesSkipped        : ${result.imagesSkipped}`)
    console.log(`  attachmentsProcessed : ${result.attachmentsProcessed}`)
    console.log(`  attachmentsSkipped   : ${result.attachmentsSkipped}`)
    if (result.errors.length) {
      console.log(`  errors (${result.errors.length}):`)
      for (const e of result.errors) console.log(`     - ${e}`)
    }

    // Query DocumentChunk for the email
    const chunks = await prisma.documentChunk.findMany({
      where:   { parentEmailId: t.id },
      orderBy: [{ chunkType: 'asc' }],
      select: {
        id: true, chunkType: true, content: true, pageNumber: true,
        sectionHeading: true, hasTable: true, hasImage: true, tokenCount: true,
        parentLinkedResourceId: true,
      },
    })

    // byType counts directly from DB
    const dbByType: Record<string, number> = {}
    for (const c of chunks) dbByType[c.chunkType] = (dbByType[c.chunkType] ?? 0) + 1
    console.log(`\n  DB DocumentChunk total: ${chunks.length}`)
    console.log(`  DB byType           : ${JSON.stringify(dbByType)}`)

    // Sample one chunk per type (first 500 chars)
    console.log(`\n  ─ Sample one chunk per type (first 500 chars) ─`)
    const seenTypes = new Set<string>()
    for (const c of chunks) {
      if (seenTypes.has(c.chunkType)) continue
      seenTypes.add(c.chunkType)
      console.log(`\n  ┌── chunkType=${c.chunkType}  pageNumber=${c.pageNumber ?? '-'}  section=${c.sectionHeading ?? '-'}`)
      console.log(`  │   tokens=${c.tokenCount}  hasTable=${c.hasTable}  hasImage=${c.hasImage}  linkedResource=${c.parentLinkedResourceId ?? '-'}`)
      console.log(`  └── content (first 500):`)
      console.log((c.content || '').slice(0, 500).split('\n').map(l => `      ${l}`).join('\n'))
    }

    console.log('')
  }

  console.log('═══════════════════════════════════════════════════════════════════')
  console.log('Done.')
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FATAL:', e)
    process.exit(1)
  })
