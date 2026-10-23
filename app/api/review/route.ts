export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { listingChanges, parseCorrections, type ListingCorrections } from '@/lib/review/corrections'
import { SAVE_FAILED } from '@/lib/review/send'

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

const ACTIONS = ['approve', 'correct', 'reject', 'mark_duplicate', 'mark_stale', 'reprocess'] as const
type ReviewAction = (typeof ACTIONS)[number]
const isReviewAction = (a: string): a is ReviewAction => (ACTIONS as readonly string[]).includes(a)

// Brief 48 (PR 3): a refusal is { ok: false, error } with a plain-English
// message, which the Review Queue page shows under the item.
const refuse = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status })

// PATCH /api/review — update status, apply corrections
//
// Brief 48 (PR 3, items 4.7 and 4.16b) [engineering precaution]: a correction is
// read into the listing's column types before anything is written, and refused
// input writes nothing (lib/review/corrections.ts). The listing is saved first and
// the item closed second, in one transaction, so a failed save leaves the item
// pending. Before this the item was closed first; a price or beds correction then
// reached the listing as text, Prisma refused it, and the item had already left
// the queue. A new category also gets a plain new title.
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const { id, action, corrections, notes } = (body ?? {}) as {
    id:           unknown
    action:       unknown
    corrections?: unknown
    notes?:       unknown
  }

  if (typeof id !== 'string' || !id || typeof action !== 'string' || !action) {
    return refuse(400, 'id and action required')
  }
  // An unknown action is refused. It used to close the item as "approved" and
  // leave the listing alone.
  if (!isReviewAction(action)) {
    return refuse(400, "That isn't an action the Review Queue knows.")
  }
  if (notes != null && typeof notes !== 'string') return refuse(400, 'Notes must be text.')

  let fields: ListingCorrections = {}
  if (action === 'correct') {
    const read = parseCorrections(corrections)
    if (!read.ok) return refuse(400, read.error)
    fields = read.fields
  }

  const item = await prisma.reviewQueueItem.findUnique({ where: { id } })
  if (!item) return refuse(404, "This item isn't in the queue any more. Reload the page to see the current list.")

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

  // The listing behind the item, read before anything is written. An item can
  // outlive its listing (re-reading an email replaces its listings and leaves the
  // review items), so approve, reject and the marks still close such an item, but
  // there's nothing to correct.
  const listing = item.opportunityId && processingStatus
    ? await prisma.extractedOpportunity.findUnique({
        where:  { id: item.opportunityId },
        select: { id: true, category: true, address: true, neighborhood: true, beds: true },
      })
    : null
  if (action === 'correct' && !listing) {
    return refuse(409, "There's no listing behind this item to correct, so nothing was saved. Approve or reject it to clear it from the queue.")
  }
  const listingData = listing && processingStatus
    ? { processingStatus, ...(isDuplicate !== null ? { isDuplicate } : {}), ...listingChanges(listing, fields) }
    : null

  try {
    await prisma.$transaction(async tx => {
      if (listing && listingData) {
        await tx.extractedOpportunity.update({ where: { id: listing.id }, data: listingData })
      }
      await tx.reviewQueueItem.update({
        where: { id },
        data: {
          status:              newStatus,
          reviewedAt:          new Date(),
          reviewNotes:         notes ?? null,
          // What the correction asked for, as stored (a new title it brought isn't listed).
          userCorrectedFields: action === 'correct' ? fields : undefined,
        },
      })
    })
  } catch (e) {
    console.error(`[review] ${action} on ${id} didn't save; the item stays pending:`, (e as Error).message)
    return refuse(500, SAVE_FAILED)
  }

  // Trigger embedding if approving/correcting (making record active)
  if (listing && (action === 'approve' || action === 'correct')) {
    // Brief 48 (PR 3): the save above is committed, so a failure here is logged and
    // no longer turns the reply into an error.
    try {
      const { buildOpportunityText, upsertOpportunityEmbedding } = await import('@/lib/embeddings')
      const opp = await prisma.extractedOpportunity.findUnique({ where: { id: listing.id } })
      if (opp) {
        upsertOpportunityEmbedding(opp.id, buildOpportunityText(opp)).catch(() => {})
      }
    } catch (e) {
      console.error(`[review] embedding refresh for ${listing.id} failed:`, (e as Error).message)
    }
  }

  return NextResponse.json({ ok: true, newStatus })
}
