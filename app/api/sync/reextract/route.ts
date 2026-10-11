export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { classifyAndExtractEmail } from '@/lib/ai'
import { buildOpportunityText, upsertOpportunityEmbedding } from '@/lib/embeddings'
import { Category, Prisma, TransactionType } from '@prisma/client'
import { maintenanceEnabled, MAINTENANCE_OFF_BODY } from '@/lib/config/maintenance'
import { REEXTRACT_TRANSACTION_TYPES, forceRequested, listingEntries, reextractSwapDecision } from '@/lib/reextractGuard'

export const maxDuration = 300

// Maintenance route (Brief 41, H6): off unless MAINTENANCE_ENABLED=true.
// Brief 41.1 (F12): it never replaces an email's saved listings with an answer
// that has none; the response reports those as skipped. "force": true in the
// body replaces them anyway.
export async function POST(req: NextRequest) {
  if (!maintenanceEnabled()) return NextResponse.json(MAINTENANCE_OFF_BODY, { status: 403 })
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

    const organizationId = await getCurrentOrgId()
    console.log(`[Reextract] Processing ${emails.length} email(s)`)

    const force = forceRequested(body)
    let totalDeleted = 0
    let totalCreated = 0
    let failed = 0
    let skipped = 0
    const summary: { subject: string; deleted: number; created: number; kept?: number; skipped?: string }[] = []

    for (const email of emails) {
      try {
        // Re-extract with the new multi-listing prompt. Brief 41 (H6): extract
        // FIRST; the old listings are only replaced once this has succeeded.
        const results = await classifyAndExtractEmail({
          subject: email.subject,
          senderName: email.senderName,
          senderEmail: email.senderEmail,
          receivedDateTime: email.receivedDateTime.toISOString(),
          bodyPreview: email.bodyPreview,
          fullBody: email.bodyContent,
          attachmentText: email.attachmentsText,
        })
        // An answer with no entries at all isn't a valid extraction (a noise
        // email still comes back as one entry, isRelevant:false): keep the old
        // listings rather than delete them and create nothing.
        if (results.length === 0) throw new Error('the extractor returned no entries; the listings were left as they were')

        const fresh: { ext: (typeof results)[number]; data: Prisma.ExtractedOpportunityUncheckedCreateInput }[] = []
        for (const ext of listingEntries(results)) {
          const category = ext.category as Category
          const transactionType = REEXTRACT_TRANSACTION_TYPES.has(ext.transactionType) ? ext.transactionType as TransactionType : TransactionType.UNKNOWN

          fresh.push({
            ext,
            data: {
              organizationId,
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
        }

        // Brief 41.1 (F12): an answer with no listings in it (only noise,
        // irrelevant or malformed entries) never wipes the saved ones.
        const saved = await prisma.extractedOpportunity.count({ where: { rawEmailId: email.id } })
        const decision = reextractSwapDecision({ saved, fresh: fresh.length, force })
        if (decision.swap) {
          // Swap: delete the old listings and create the new ones in one
          // transaction, so a failure leaves the old ones in place.
          const [{ count: deleted }, ...opps] = await prisma.$transaction([
            prisma.extractedOpportunity.deleteMany({ where: { rawEmailId: email.id } }),
            ...fresh.map(f => prisma.extractedOpportunity.create({ data: f.data })),
          ])
          const created = opps.length
          totalDeleted += deleted
          totalCreated += created
          opps.forEach((opp, k) => {
            upsertOpportunityEmbedding(opp.id, buildOpportunityText({ ...fresh[k].ext, ...opp })).catch(() => {})
          })

          console.log(`[Reextract] "${email.subject}": ${deleted} deleted → ${created} created`)
          summary.push({ subject: email.subject, deleted, created })
        } else {
          if (decision.kept) skipped++
          console.log(`[Reextract] "${email.subject}": ${decision.reason}`)
          summary.push({ subject: email.subject, deleted: 0, created: 0, ...(decision.kept ? { kept: decision.kept, skipped: decision.reason } : {}) })
        }

        // Small delay between emails to stay under rate limits
        await new Promise(r => setTimeout(r, 500))
      } catch (e) {
        console.error(`[Reextract] Failed for "${email.subject}":`, (e as Error).message)
        failed++
        summary.push({ subject: email.subject, deleted: 0, created: -1 })
      }
    }

    return NextResponse.json({ totalDeleted, totalCreated, failed, skipped, summary })
  } catch (err) {
    console.error('[Reextract] Error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
