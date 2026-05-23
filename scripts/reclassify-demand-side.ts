/**
 * One-time script: re-classify all demand-side records (BUYER_ISO + RENTER_INQUIRY)
 * using the improved sourceClassifier prompt that now explicitly distinguishes
 * purchase intent (BUYER_ISO) from rental intent (RENTER_INQUIRY).
 *
 * Run: npx tsx scripts/reclassify-demand-side.ts
 * Delete this file after running.
 */
import 'dotenv/config'
import { prisma }                    from '../lib/prisma'
import { sourceClassifier }          from '../lib/ingestion/sourceClassifier'
import { buildOpportunityText, upsertOpportunityEmbedding } from '../lib/embeddings'

const BATCH_SIZE   = 5   // concurrent classifier calls
const BATCH_DELAY  = 300 // ms between batches — avoid rate limiting
const MIN_CONFIDENCE = 0.65

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

async function main() {
  const records = await prisma.extractedOpportunity.findMany({
    where: {
      category: { in: ['BUYER_ISO', 'RENTER_INQUIRY'] },
      processingStatus: { notIn: ['rejected', 'duplicate', 'stale'] },
    },
    select: {
      id: true,
      category: true,
      extractedTitle: true,
      extractedSummary: true,
      neighborhood: true,
      borough: true,
      address: true,
      propertyType: true,
      beds: true,
      baths: true,
      units: true,
      price: true,
      minPrice: true,
      maxPrice: true,
      sourceBrokerage: true,
      sourceAgentName: true,
      availabilityDate: true,
      rawEmail: {
        select: {
          id: true,
          graphMessageId: true,
          subject: true,
          senderName: true,
          senderEmail: true,
          bodyPreview: true,
          bodyContent: true,
          attachmentsText: true,
        },
      },
    },
  })

  console.log(`Found ${records.length} demand-side records to re-evaluate`)

  let reclassified = 0
  let skipped = 0
  let errors = 0

  // Process in batches to avoid hammering the API
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE)

    await Promise.all(batch.map(async (record) => {
      const email = record.rawEmail

      // Skip synthetic StreetEasy records — they have no real email body to re-classify from
      if (!email || email.graphMessageId.startsWith('streeteasy')) {
        skipped++
        return
      }

      const attachmentNames  = email.attachmentsText ? ['attachment'] : []
      const bodyFirst500 = email.bodyContent
        ? stripHtml(email.bodyContent).slice(0, 500)
        : null

      try {
        const result = await sourceClassifier({
          rawEmailId:        email.id,
          subject:           email.subject,
          senderName:        email.senderName,
          senderEmail:       email.senderEmail,
          bodyPreview:       email.bodyPreview,
          bodyFirst500,
          attachmentNames,
          attachmentMimeTypes: [],
          attachmentCount:   attachmentNames.length,
        })

        const newCategory = result.category
        const isReclassifiable =
          (record.category === 'BUYER_ISO'      && newCategory === 'RENTER_INQUIRY') ||
          (record.category === 'RENTER_INQUIRY' && newCategory === 'BUYER_ISO')

        if (isReclassifiable && result.confidence >= MIN_CONFIDENCE) {
          console.log(
            `  RECLASSIFY [${record.id}] ${record.category} → ${newCategory}` +
            ` (conf: ${result.confidence.toFixed(2)}) | "${email.subject.slice(0, 60)}"`
          )

          await prisma.extractedOpportunity.update({
            where: { id: record.id },
            data:  { category: newCategory as never },
          })

          // Re-embed with the corrected category so semantic search reflects the change
          const embeddingText = buildOpportunityText({ ...record, category: newCategory })
          await upsertOpportunityEmbedding(record.id, embeddingText)

          reclassified++
        }
      } catch (e) {
        console.error(`  ERROR [${record.id}]:`, (e as Error).message)
        errors++
      }
    }))

    if (i + BATCH_SIZE < records.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY))
    }

    const processed = Math.min(i + BATCH_SIZE, records.length)
    process.stdout.write(`\rProgress: ${processed}/${records.length}`)
  }

  console.log(`\n\nDone.`)
  console.log(`  Reclassified: ${reclassified}`)
  console.log(`  Skipped (synthetic): ${skipped}`)
  console.log(`  Errors: ${errors}`)
  console.log(`  Unchanged: ${records.length - reclassified - skipped - errors}`)

  await prisma.$disconnect()
}

main()
