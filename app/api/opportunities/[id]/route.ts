export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

const SE_LISTABLE = new Set([
  'ACTIVE_SALE_LISTING','COMING_SOON_SALE','OFF_MARKET_SALE','RENTAL_LISTING',
  'COMING_SOON_RENTAL','DEVELOPMENT_INVENTORY','SPONSOR_UNIT','PRICE_DROP',
  'BACK_ON_MARKET','OPEN_HOUSE','SHOWING_CONFIRMATION','COMING_SOON_DEVELOPMENT',
])

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  let opp = await prisma.extractedOpportunity.findUnique({
    where: { id },
    include: { rawEmail: true },
  })

  if (!opp) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // If no streetEasyId yet and it's a listable category, look it up in real-time
  // and cache the result so subsequent views have the direct listing URL.
  if (!opp.streetEasyId && opp.address && SE_LISTABLE.has(opp.category)) {
    try {
      const { syncOpportunityStatus } = await import('@/lib/streetEasySync')
      const result = await syncOpportunityStatus(opp.id)
      console.log('[SE lookup]', opp.address, '→', result.streetEasyStatus, '| id:', opp.streetEasyId)
      opp = await prisma.extractedOpportunity.findUnique({
        where: { id },
        include: { rawEmail: true },
      }) ?? opp
      console.log('[SE lookup] stored streetEasyId:', opp.streetEasyId)
    } catch (e) {
      console.error('[SE lookup] failed:', e)
    }
  }

  return NextResponse.json(opp)
}
