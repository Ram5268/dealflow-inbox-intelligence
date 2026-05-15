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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))

    // Find the target email(s)
    // Accepts: rawEmailId (specific), subjectContains (search by subject), limit (batch)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {
      graphMessageId: { not: 'streeteasy-hotsheet-synthetic' },
    }
    if (body.rawEmailId) {
      where.id = body.rawEmailId
    } else if (body.subjectContains) {
      where.subject = { contains: body.subjectContains, mode: 'insensitive' }
    }

    const limit: number = body.limit ?? 20
    const emails = await prisma.rawEmail.findMany({
      where,
      orderBy: { receivedDateTime: 'desc' },
      take: limit,
      select: {
        id: true, subject: true, senderName: true, senderEmail: true,
        receivedDateTime: true, bodyPreview: true, bodyContent: true, attachmentsText: true,
      },
    })

    if (emails.length === 0) {
      return NextResponse.json({ error: 'No matching emails found' }, { status: 404 })
    }

    console.log(`[Reextract] Processing ${emails.length} email(s)`)

    let totalDeleted = 0
    let totalCreated = 0
    let failed = 0
    const summary: { subject: string; deleted: number; created: number }[] = []

    for (const email of emails) {
      try {
        // Delete all existing opportunities for this email
        const { count: deleted } = await prisma.extractedOpportunity.deleteMany({
          where: { rawEmailId: email.id },
        })
        totalDeleted += deleted

        // Re-extract with the new multi-listing prompt
        const results = await classifyAndExtractEmail({
          subject: email.subject,
          senderName: email.senderName,
          senderEmail: email.senderEmail,
          receivedDateTime: email.receivedDateTime.toISOString(),
          bodyPreview: email.bodyPreview,
          fullBody: email.bodyContent,
          attachmentText: email.attachmentsText,
        })

        let created = 0
        for (const ext of results) {
          if (!ext.isRelevant || ext.category === 'NOISE') continue

          const category = VALID_CATEGORIES.has(ext.category) ? ext.category as Category : Category.NOISE
          if (category === Category.NOISE) continue
          const transactionType = VALID_TX.has(ext.transactionType) ? ext.transactionType as TransactionType : TransactionType.UNKNOWN

          const opp = await prisma.extractedOpportunity.create({
            data: {
              rawEmailId: email.id, category, transactionType,
              propertyType: ext.propertyType ?? null,
              address: ext.address ?? null, neighborhood: ext.neighborhood ?? null,
              borough: ext.borough ?? null, city: ext.city ?? null,
              state: ext.state ?? null, zip: ext.zip ?? null,
              price: ext.price ?? null, minPrice: ext.minPrice ?? null,
              maxPrice: ext.maxPrice ?? null, beds: ext.beds ?? null,
              baths: ext.baths ?? null, units: ext.units ?? null,
              squareFeet: ext.squareFeet ?? null, availabilityDate: ext.availabilityDate ?? null,
              sourceAgentName: ext.sourceAgentName ?? null, sourceAgentEmail: ext.sourceAgentEmail ?? null,
              sourceBrokerage: ext.sourceBrokerage ?? null, clientSide: ext.clientSide ?? null,
              status: ext.status ?? null, extractedTitle: ext.extractedTitle,
              extractedSummary: ext.extractedSummary, classificationReason: ext.classificationReason,
              confidenceScore: ext.confidenceScore,
            },
          })
          created++
          totalCreated++

          upsertOpportunityEmbedding(opp.id, buildOpportunityText({ ...ext, ...opp })).catch(() => {})
        }

        console.log(`[Reextract] "${email.subject}": ${deleted} deleted → ${created} created`)
        summary.push({ subject: email.subject, deleted, created })

        // Small delay between emails to stay under rate limits
        await new Promise(r => setTimeout(r, 500))
      } catch (e) {
        console.error(`[Reextract] Failed for "${email.subject}":`, (e as Error).message)
        failed++
        summary.push({ subject: email.subject, deleted: 0, created: -1 })
      }
    }

    return NextResponse.json({ totalDeleted, totalCreated, failed, summary })
  } catch (err) {
    console.error('[Reextract] Error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
