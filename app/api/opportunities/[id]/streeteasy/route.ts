export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { SE_CHECKABLE_CATEGORIES } from '@/lib/streetEasyStatusUpdate'

// A miss can be up to 17 sequential StreetEasy calls (the area and its borough's
// fallbacks).
export const maxDuration = 60

// Brief 41 (H5): the StreetEasy lookup for one listing, run only when Ryan asks
// for it ("Find listing" on the listing page). It used to run on every view of
// a listing with no streetEasyId. A miss changes nothing but the check time;
// only StreetEasy's own status marks a listing delisted or sold.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const before = await prisma.extractedOpportunity.findUnique({
    where: { id },
    select: { address: true, category: true, streetEasyCheckedAt: true },
  })
  if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!before.address || !SE_CHECKABLE_CATEGORIES.has(before.category)) {
    return NextResponse.json({ error: 'This listing has nothing to look up on StreetEasy' }, { status: 400 })
  }

  try {
    const { syncOpportunityStatus } = await import('@/lib/streetEasySync')
    const result = await syncOpportunityStatus(id)
    const after = await prisma.extractedOpportunity.findUnique({
      where: { id },
      select: { streetEasyId: true, streetEasyStatus: true, processingStatus: true, streetEasyCheckedAt: true },
    })
    // No new check time: the lookup didn't run (StreetEasy sync is paused,
    // test mode, or no API key).
    const checked = !!after?.streetEasyCheckedAt && after.streetEasyCheckedAt.getTime() !== before.streetEasyCheckedAt?.getTime()
    return NextResponse.json({ ...result, ...after, checked })
  } catch (e) {
    console.error('[SE lookup] failed:', e)
    return NextResponse.json({ error: 'StreetEasy lookup failed' }, { status: 502 })
  }
}
