import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { classifyAndExtractEmail } from '@/lib/ai'
import { buildOpportunityText, upsertOpportunityEmbedding } from '@/lib/embeddings'
import { Category, TransactionType } from '@prisma/client'

export const maxDuration = 300

const VALID_CATEGORIES = new Set([
  'COMING_SOON_SALE','OFF_MARKET_SALE','ACTIVE_SALE_LISTING','RENTAL_LISTING',
  'BUYER_ISO','RENTER_INQUIRY','SELLER_LEAD','LANDLORD_LEAD',
  'DEVELOPMENT_INVENTORY','OPEN_HOUSE','PRICE_DROP','BACK_ON_MARKET','NOISE',
])
const VALID_TX = new Set([
  'SALE','RENTAL','BUYER_NEED','RENTER_NEED','SELLER_LEAD','LANDLORD_LEAD','UNKNOWN',
])

export async function GET() {
  const remaining = await prisma.extractedOpportunity.count({
    where: {
      classificationReason: { not: { contains: 'SENDER ROLE' } },
      rawEmail: { graphMessageId: { not: 'streeteasy-hotsheet-synthetic' } },
    },
  })
  const done = await prisma.extractedOpportunity.count({
    where: {
      classificationReason: { contains: 'SENDER ROLE' },
      rawEmail: { graphMessageId: { not: 'streeteasy-hotsheet-synthetic' } },
    },
  })
  return NextResponse.json({ remaining, alreadyDone: done, total: remaining + done })
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const limit: number = body.limit ?? 150

    const opps = await prisma.extractedOpportunity.findMany({
      where: {
        // Only records not yet processed with the new intent-based prompt
        // New prompt always includes "SENDER ROLE" in classificationReason
        classificationReason: { not: { contains: 'SENDER ROLE' } },
        rawEmail: { graphMessageId: { not: 'streeteasy-hotsheet-synthetic' } },
      },
      take: limit,
      include: {
        rawEmail: {
          select: {
            subject: true, senderName: true, senderEmail: true,
            receivedDateTime: true, bodyPreview: true, bodyContent: true, attachmentsText: true,
          },
        },
      },
    })

    console.log(`[Reclassify] Processing ${opps.length} opportunities`)

    let reclassified = 0
    let categoryChanged = 0
    let failed = 0
    const errors: string[] = []

    // Process one at a time to stay under OpenAI rate limits
    for (const opp of opps) {
      await (async () => {
        try {
          const email = opp.rawEmail
          if (!email) { failed++; errors.push(`${opp.id}: no rawEmail`); return }
          const results = await classifyAndExtractEmail({
            subject: email.subject,
            senderName: email.senderName,
            senderEmail: email.senderEmail,
            receivedDateTime: email.receivedDateTime.toISOString(),
            bodyPreview: email.bodyPreview,
            fullBody: email.bodyContent,
            attachmentText: email.attachmentsText,
          })
          // Reclassify updates the existing record using the primary result
          const ext = results.find(r => r.isRelevant && r.category !== 'NOISE') ?? results[0]
          if (!ext) { failed++; return }

          // If now classified as NOISE, delete the opportunity
          if (!ext.isRelevant || ext.category === 'NOISE') {
            await prisma.extractedOpportunity.delete({ where: { id: opp.id } })
            reclassified++
            if (opp.category !== 'NOISE') categoryChanged++
            return
          }

          const category = VALID_CATEGORIES.has(ext.category) ? ext.category as Category : opp.category
          const transactionType = VALID_TX.has(ext.transactionType) ? ext.transactionType as TransactionType : opp.transactionType
          const prevCategory = opp.category

          await prisma.extractedOpportunity.update({
            where: { id: opp.id },
            data: {
              category, transactionType,
              propertyType: ext.propertyType ?? opp.propertyType,
              address: ext.address ?? opp.address,
              neighborhood: ext.neighborhood ?? opp.neighborhood,
              borough: ext.borough ?? opp.borough,
              price: ext.price ?? opp.price,
              minPrice: ext.minPrice ?? opp.minPrice,
              maxPrice: ext.maxPrice ?? opp.maxPrice,
              beds: ext.beds ?? opp.beds,
              baths: ext.baths ?? opp.baths,
              squareFeet: ext.squareFeet ?? opp.squareFeet,
              sourceAgentName: ext.sourceAgentName ?? opp.sourceAgentName,
              sourceBrokerage: ext.sourceBrokerage ?? opp.sourceBrokerage,
              extractedTitle: ext.extractedTitle,
              extractedSummary: ext.extractedSummary,
              classificationReason: ext.classificationReason,
              confidenceScore: ext.confidenceScore,
            },
          })

          // Re-embed with updated fields
          upsertOpportunityEmbedding(opp.id, buildOpportunityText({ ...ext, id: opp.id } as Parameters<typeof buildOpportunityText>[0])).catch(() => {})

          reclassified++
          if (category !== prevCategory) {
            categoryChanged++
            console.log(`[Reclassify] ${opp.extractedTitle}: ${prevCategory} → ${category} (${Math.round(ext.confidenceScore * 100)}%)`)
          }
        } catch (e) {
          const msg = (e as Error).message
          console.error(`[Reclassify] Failed for ${opp.id}:`, msg)
          errors.push(`${opp.id}: ${msg}`)
          failed++
        }
      })()
      // Delay to stay under OpenAI rate limits
      await new Promise(r => setTimeout(r, 1500))
    }

    console.log(`[Reclassify] Done — ${reclassified} updated, ${categoryChanged} category changes, ${failed} failed`)
    return NextResponse.json({ total: opps.length, reclassified, categoryChanged, failed, sampleErrors: errors.slice(0, 5) })
  } catch (err) {
    console.error('[Reclassify] Error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
