export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// Brief 3.0, Step 3 — cards Ryan has already tapped, from click history.
// Single-tenant MVP: no auth. Distinct cardId across all DriftInteractionClick
// rows drives the "viewed" indicator on chat result cards.
export async function GET() {
  try {
    const rows = await prisma.driftInteractionClick.findMany({
      distinct: ['cardId'],
      select: { cardId: true },
    })
    return NextResponse.json({ seenCardIds: rows.map(r => r.cardId) })
  } catch (err) {
    console.error('[DealFlow] seen-cards error (non-fatal):', err)
    return NextResponse.json({ seenCardIds: [] })
  }
}
