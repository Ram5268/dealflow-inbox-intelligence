export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { Category, DismissalReason, Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { resolveDismissKey } from '@/lib/matching/dismissKey'
import { resolveSupply } from '@/lib/matching/supplyResolver'

// POST /api/matches/[id]/dismiss
// Body: { reason?: DismissalReason }  — reason is nullable (Skip reason = null).
// Records a MatchDismissal on the underlying (party, listing) pair so the match
// is hidden from GET /api/matches. Idempotent-ish: a second dismiss returns 409
// with the existing dismissal id rather than erroring. Logged to AuditLog per the
// CLAUDE.md safety requirement. This does NOT touch email — read-only holds.
const VALID_REASONS = new Set(Object.values(DismissalReason))

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params

  let body: { reason?: string | null } = {}
  try { body = (await req.json()) as { reason?: string | null } } catch { /* empty body = skip reason */ }

  const reason: DismissalReason | null =
    body.reason == null ? null :
    VALID_REASONS.has(body.reason as DismissalReason) ? (body.reason as DismissalReason) :
    null
  if (body.reason != null && reason === null) {
    return NextResponse.json({ error: `invalid reason '${body.reason}'` }, { status: 400 })
  }

  const match = await prisma.match.findUnique({
    where:  { id },
    select: {
      opportunityId: true, counterpartId: true, organizationId: true, opportunityType: true,
    },
  })
  if (!match) return NextResponse.json({ error: 'match not found' }, { status: 404 })

  // Brief 8.0-lite Fix #3a — resolve (partyId, listingId) from the opportunity's
  // CATEGORY, not the field name: an ISO-triggered match stores the party in
  // opportunityId, so the old partyId=counterpartId assumption inverted the keys.
  // Brief 32 — supply may be a MojoContact seller (category=null); a contact supply
  // IS the off-market listing side, and dismissKey only needs supply-vs-demand
  // direction, so coalesce null → OFF_MARKET_SALE.
  const supply = await resolveSupply(prisma, match.opportunityId, match.opportunityType)
  const { partyId, listingId } = resolveDismissKey({
    opportunityId: match.opportunityId,
    counterpartId: match.counterpartId,
    opportunityType: match.opportunityType,
    opportunityCategory: supply?.category ?? Category.OFF_MARKET_SALE,
  })

  const existing = await prisma.matchDismissal.findUnique({
    where: { partyId_listingId: { partyId, listingId } },
    select: { id: true },
  })
  if (existing) {
    return NextResponse.json({ ok: true, dismissalId: existing.id, alreadyDismissed: true }, { status: 409 })
  }

  try {
    const dismissal = await prisma.matchDismissal.create({
      data: { partyId, listingId, dismissalReason: reason },
      select: { id: true },
    })

    await prisma.auditLog.create({
      data: {
        organizationId: match.organizationId,
        action: 'MATCH_DISMISSED',
        detailsJson: { matchId: id, partyId, listingId, reason, at: new Date().toISOString() },
      },
    })

    return NextResponse.json({ ok: true, dismissalId: dismissal.id })
  } catch (e) {
    // Unique-constraint race: another request dismissed the same pair first.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const row = await prisma.matchDismissal.findUnique({
        where: { partyId_listingId: { partyId, listingId } },
        select: { id: true },
      })
      return NextResponse.json({ ok: true, dismissalId: row?.id, alreadyDismissed: true }, { status: 409 })
    }
    throw e
  }
}

// DELETE /api/matches/[id]/dismiss — undo a dismissal (re-surfaces the match).
// Backs the toast's Undo action so a restore is truthful (the pair reappears on
// the next fetch, not just locally). No-op-safe: returns ok even if no row.
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params

  const match = await prisma.match.findUnique({
    where:  { id },
    select: {
      opportunityId: true, counterpartId: true, organizationId: true, opportunityType: true,
    },
  })
  if (!match) return NextResponse.json({ error: 'match not found' }, { status: 404 })

  // Same category-aware key as POST (Fix #3a) so an undo targets the row we wrote.
  // Brief 32 — contact supply (category=null) → OFF_MARKET_SALE (off-market side).
  const supply = await resolveSupply(prisma, match.opportunityId, match.opportunityType)
  const { partyId, listingId } = resolveDismissKey({
    opportunityId: match.opportunityId,
    counterpartId: match.counterpartId,
    opportunityType: match.opportunityType,
    opportunityCategory: supply?.category ?? Category.OFF_MARKET_SALE,
  })

  const { count } = await prisma.matchDismissal.deleteMany({ where: { partyId, listingId } })

  if (count > 0) {
    await prisma.auditLog.create({
      data: {
        organizationId: match.organizationId,
        action: 'MATCH_DISMISS_UNDONE',
        detailsJson: { matchId: id, partyId, listingId, at: new Date().toISOString() },
      },
    })
  }

  return NextResponse.json({ ok: true, removed: count })
}
