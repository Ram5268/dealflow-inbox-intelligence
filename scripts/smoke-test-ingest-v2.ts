import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { ingestEmailV2 } from '../lib/ingestion/ingestEmailV2'

async function main() {
  console.log('Smoke test: Ingestion V2 (body + linked HTML + scrape filter)\n')

  const explicitId = process.argv[2]
  const email = explicitId
    ? await prisma.rawEmail.findUnique({
        where:  { id: explicitId },
        select: { id: true, subject: true, senderEmail: true, receivedDateTime: true },
      })
    : await prisma.rawEmail.findFirst({
        where: {
          OR: [
            { bodyContent: { not: null } },
            { bodyPreview: { not: null } },
          ],
        },
        orderBy: { receivedDateTime: 'desc' },
        select: { id: true, subject: true, senderEmail: true, receivedDateTime: true },
      })

  if (!email) {
    console.error('❌ No body-bearing email found.')
    process.exit(1)
  }

  console.log(`  Target email: ${email.id}`)
  console.log(`    Subject:    ${email.subject.slice(0, 80)}`)
  console.log(`    From:       ${email.senderEmail ?? '(unknown)'}`)
  console.log(`    Received:   ${email.receivedDateTime.toISOString()}\n`)

  console.log('  Running ingestEmailV2…')
  const t0 = Date.now()
  const result = await ingestEmailV2(email.id)
  const ms = Date.now() - t0

  console.log(`\n  ── Result (${ms}ms) ────────────────`)
  console.log(`  Thread:         ${result.threadId}`)
  console.log(`  Chunks created: ${result.chunksCreated}`)
  console.log(`  By type:        ${JSON.stringify(result.byType)}`)
  console.log(`  Links found:    ${result.linksFound}`)
  console.log(`  Links scraped:  ${result.linksScraped}  (Firecrawl calls)`)
  console.log(`  Links filtered: ${result.linksFiltered} (junk dropped before scrape)`)
  console.log(`  Links deferred: ${result.linksDeferred} (PDF/Dropbox/Drive — Phase 3C)`)
  if (result.errors.length > 0) {
    console.log(`  Errors (${result.errors.length}):`)
    result.errors.forEach(e => console.log(`    - ${e}`))
  }

  if (result.chunksCreated === 0) {
    console.error('\n❌ Smoke test failed: 0 chunks created.')
    process.exit(1)
  }

  // Verify DB matches the orchestrator's count.
  const dbChunks = await prisma.documentChunk.count({ where: { parentEmailId: email.id } })
  console.log(`\n  Postgres DocumentChunk rows for this email: ${dbChunks}`)
  if (dbChunks !== result.chunksCreated) {
    console.warn(`  ⚠️  Mismatch: orchestrator reported ${result.chunksCreated}, DB has ${dbChunks}`)
  }

  console.log('\n✅ Smoke test passed. Ingestion V2 is live.')
}

main().then(() => process.exit(0)).catch(e => {
  console.error('\n❌ Smoke test failed:', e)
  process.exit(1)
})
