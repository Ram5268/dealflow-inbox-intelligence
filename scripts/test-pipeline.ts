// Runs the new ingestion pipeline on the most recent email without creating duplicate records.
// Side effects: writes to AIExtractionLog, updates RawEmail checkpoint fields.
import { prisma } from '../lib/prisma'
import { ingestEmail } from '../lib/ingestion/ingestEmail'

async function main() {
  const email = await prisma.rawEmail.findFirst({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, subject: true, senderName: true, senderEmail: true,
      bodyPreview: true, bodyContent: true, attachmentsText: true,
      createdAt: true, classifierStatus: true,
    }
  })

  if (!email) { console.log('No emails found'); return }

  console.log(`\nTesting pipeline on: "${email.subject}"`)
  console.log(`From: ${email.senderName} | Received: ${email.createdAt.toLocaleString()}`)
  console.log(`Classifier status: ${email.classifierStatus ?? 'not yet run'}\n`)

  const results = await ingestEmail({
    rawEmailId:          email.id,
    subject:             email.subject,
    senderName:          email.senderName,
    senderEmail:         email.senderEmail,
    bodyPreview:         email.bodyPreview,
    bodyFirst500:        email.bodyContent ? email.bodyContent.slice(0, 500) : null,
    attachmentNames:     [],
    attachmentMimeTypes: [],
    attachmentCount:     0,
    fullBody:            email.bodyContent,
    attachmentText:      email.attachmentsText,
  })

  console.log(`── Pipeline returned ${results.length} result(s) ──`)
  for (const r of results) {
    console.log(`\n  category:         ${r.category}`)
    console.log(`  processingStatus: ${r.processingStatus ?? 'active'}`)
    console.log(`  confidenceScore:  ${Math.round(r.confidenceScore * 100)}%`)
    console.log(`  address:          ${r.address ?? '(null)'}`)
    console.log(`  neighborhood:     ${r.neighborhood ?? '(null)'}`)
    console.log(`  price:            ${r.price ?? r.maxPrice ?? '(null)'}`)
    console.log(`  beds:             ${r.beds ?? '(null)'}`)
    console.log(`  title:            ${r.extractedTitle}`)
    if (r.flagReasons?.length) console.log(`  flags:            ${r.flagReasons.join(', ')}`)
  }

  // Show what was logged
  const log = await prisma.aIExtractionLog.findMany({
    where: { rawEmailId: email.id },
    orderBy: { createdAt: 'asc' },
  })
  console.log(`\n── AIExtractionLog entries written ──`)
  for (const l of log) {
    console.log(`  ${l.extractorType}: confidence=${Math.round((l.confidenceScore ?? 0) * 100)}%`)
  }
}

main().catch(console.error).finally(() => prisma.$disconnect())
