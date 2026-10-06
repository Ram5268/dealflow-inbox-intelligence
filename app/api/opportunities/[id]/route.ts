export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// Read-only. Brief 41 (H5): opening a listing used to run a live StreetEasy
// lookup when it had no streetEasyId, and any miss marked it delisted + stale.
// The lookup is now an explicit action: POST /api/opportunities/:id/streeteasy
// ("Find listing" on the listing page).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const opp = await prisma.extractedOpportunity.findUnique({
    where: { id },
    include: { rawEmail: true },
  })

  if (!opp) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json(opp)
}
