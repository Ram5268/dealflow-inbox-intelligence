export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// GET /api/review — list pending review items with joined opportunity + email data
export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get('status') ?? 'pending'
  const take   = parseInt(req.nextUrl.searchParams.get('limit') ?? '50')

  const items = await prisma.reviewQueueItem.findMany({
    where: { status },
    orderBy: { createdAt: 'asc' },
    take,
  })

  // Load related opportunity and email data in a single query
  const oppIds  = [...new Set(items.map(i => i.opportunityId).filter(Boolean))] as string[]
  const emailIds = [...new Set(items.map(i => i.rawEmailId).filter(Boolean))]  as string[]

  const [opps, emails] = await Promise.all([
    oppIds.length > 0
      ? prisma.extractedOpportunity.findMany({
          where: { id: { in: oppIds } },
          select: {
            id: true, category: true, transactionType: true,
            address: true, neighborhood: true, borough: true,
            price: true, minPrice: true, maxPrice: true,
            beds: true, baths: true, units: true, squareFeet: true,
            propertyType: true, availabilityDate: true,
            sourceAgentName: true, sourceAgentEmail: true, sourceBrokerage: true,
            extractedTitle: true, extractedSummary: true,
            classificationReason: true, confidenceScore: true,
            processingStatus: true, isDuplicate: true,
            rawEmail: {
              select: {
                subject: true, senderName: true, senderEmail: true,
                receivedDateTime: true, bodyPreview: true, webLink: true,
              },
            },
          },
        })
      : [],
    emailIds.length > 0
      ? prisma.rawEmail.findMany({
          where: { id: { in: emailIds } },
          select: {
            id: true, subject: true, senderName: true, senderEmail: true,
            receivedDateTime: true, bodyPreview: true, webLink: true,
          },
        })
      : [],
  ])

  const oppMap   = Object.fromEntries(opps.map(o => [o.id, o]))
  const emailMap = Object.fromEntries(emails.map(e => [e.id, e]))

  const enriched = items.map(item => ({
    ...item,
    opportunity: item.opportunityId ? oppMap[item.opportunityId] ?? null : null,
    email:       item.rawEmailId   ? emailMap[item.rawEmailId]   ?? null : null,
  }))

  const pendingCount = await prisma.reviewQueueItem.count({ where: { status: 'pending' } })

  return NextResponse.json({ items: enriched, pendingCount })
}

// PATCH /api/review — update status, apply corrections
export async function PATCH(req: NextRequest) {
  const body = await req.json()
  const { id, action, corrections, notes } = body as {
    id:           string
    action:       'approve' | 'correct' | 'reject' | 'mark_duplicate' | 'mark_stale' | 'reprocess'
    corrections?: Record<string, unknown>
    notes?:       string
  }

  if (!id || !action) {
    return NextResponse.json({ error: 'id and action required' }, { status: 400 })
  }

  const item = await prisma.reviewQueueItem.findUnique({ where: { id } })
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let newStatus: string = 'approved'
  let processingStatus: string | null = null
  let isDuplicate: boolean | null = null

  switch (action) {
    case 'approve':
      newStatus = 'approved'
      processingStatus = 'active'
      break
    case 'correct':
      newStatus = 'corrected'
      processingStatus = 'active'
      break
    case 'reject':
      newStatus = 'rejected'
      processingStatus = 'rejected'
      break
    case 'mark_duplicate':
      newStatus = 'marked_duplicate'
      processingStatus = 'duplicate'
      isDuplicate = true
      break
    case 'mark_stale':
      newStatus = 'marked_stale'
      processingStatus = 'stale'
      break
    case 'reprocess':
      newStatus = 'reprocessed'
      break
  }

  await prisma.reviewQueueItem.update({
    where: { id },
    data: {
      status:              newStatus,
      reviewedAt:          new Date(),
      reviewNotes:         notes ?? null,
      userCorrectedFields: corrections ? (corrections as object) : undefined,
    },
  })

  if (item.opportunityId && processingStatus) {
    const updateData: Record<string, unknown> = { processingStatus }
    if (isDuplicate !== null) updateData.isDuplicate = isDuplicate

    // Apply field corrections from user
    if (corrections && action === 'correct') {
      const allowed = ['address', 'neighborhood', 'borough', 'price', 'minPrice', 'maxPrice',
                       'beds', 'baths', 'units', 'squareFeet', 'propertyType', 'availabilityDate',
                       'extractedTitle', 'extractedSummary', 'category', 'status']
      for (const key of allowed) {
        if (corrections[key] !== undefined) updateData[key] = corrections[key]
      }
    }

    await prisma.extractedOpportunity.update({
      where: { id: item.opportunityId },
      data:  updateData as Parameters<typeof prisma.extractedOpportunity.update>[0]['data'],
    })

    // Trigger embedding if approving/correcting (making record active)
    if (action === 'approve' || action === 'correct') {
      const { buildOpportunityText, upsertOpportunityEmbedding } = await import('@/lib/embeddings')
      const opp = await prisma.extractedOpportunity.findUnique({ where: { id: item.opportunityId } })
      if (opp) {
        upsertOpportunityEmbedding(opp.id, buildOpportunityText(opp)).catch(() => {})
      }
    }
  }

  return NextResponse.json({ ok: true, newStatus })
}
