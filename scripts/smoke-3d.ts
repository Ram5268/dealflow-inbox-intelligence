import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { ingestEmailV2 } from '../lib/ingestion/ingestEmailV2'

async function main() {
  const emailId = process.argv[2]
  if (!emailId) {
    console.error('Usage: tsx scripts/smoke-3d.ts <rawEmailId>')
    process.exit(1)
  }

  const email = await prisma.rawEmail.findUnique({
    where:  { id: emailId },
    select: { id: true, subject: true, senderEmail: true, receivedDateTime: true },
  })
  if (!email) {
    console.error(`No RawEmail with id ${emailId}`)
    process.exit(1)
  }

  const attachments = await prisma.attachment.findMany({
    where:  { rawEmailId: emailId },
    select: { id: true, name: true, mimeType: true, sizeBytes: true, contentBytes: true },
  })

  console.log(`[smoke-3d] target: ${email.id}`)
  console.log(`  Subject:    ${email.subject.slice(0, 80)}`)
  console.log(`  Received:   ${email.receivedDateTime.toISOString()}`)
  console.log(`  Attachments rows: ${attachments.length}`)
  for (const a of attachments) {
    const hasBytes = a.contentBytes !== null
    console.log(`    - ${a.name}  ${a.mimeType}  ${a.sizeBytes ?? '?'}B  bytes=${hasBytes}`)
  }
  console.log()

  await prisma.rawEmail.update({
    where: { id: emailId },
    data:  { embeddedAt: null },
  })

  console.log('[smoke-3d] running ingestEmailV2…')
  const t0 = Date.now()
  const result = await ingestEmailV2(email.id)
  const ms = Date.now() - t0

  console.log(`\n  ── Result (${ms}ms) ────────────────`)
  console.log(`  Thread:                  ${result.threadId}`)
  console.log(`  Chunks created:          ${result.chunksCreated}`)
  console.log(`  byType:                  ${JSON.stringify(result.byType)}`)
  console.log(`  Links found / scraped:   ${result.linksFound} / ${result.linksScraped}`)
  console.log(`  Links deferred / dropped: ${result.linksDeferred} / ${result.linksFiltered}`)
  console.log(`  Images processed/skipped: ${result.imagesProcessed} / ${result.imagesSkipped}`)
  console.log(`  Attachments processed/skipped: ${result.attachmentsProcessed} / ${result.attachmentsSkipped}`)

  if (result.errors.length > 0) {
    console.log(`  Errors (${result.errors.length}):`)
    result.errors.forEach(e => console.log(`    - ${e}`))
  }

  const dbChunks = await prisma.documentChunk.findMany({
    where:  { parentEmailId: emailId },
    select: { chunkType: true, pageNumber: true, parentAttachmentId: true },
  })
  const byType: Record<string, number> = {}
  for (const c of dbChunks) byType[c.chunkType] = (byType[c.chunkType] ?? 0) + 1
  console.log(`\n  Postgres DocumentChunk rows: ${dbChunks.length}`)
  console.log(`  byType (DB):                 ${JSON.stringify(byType)}`)

  const attachmentChunks = dbChunks.filter(c => c.parentAttachmentId !== null)
  console.log(`  Attachment-derived chunks:   ${attachmentChunks.length}`)
}

main()
  .then(() => process.exit(0))
  .catch(e => { console.error('\n[smoke-3d] failed:', e); process.exit(1) })
