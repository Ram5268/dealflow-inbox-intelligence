export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { parseSearchQuery, SearchCriteria } from '@/lib/ai'
import { rankOpportunities, RankedOpportunity } from '@/lib/ranking'
import { Category, TransactionType } from '@prisma/client'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const query: string = body.query ?? ''

  if (!query.trim()) {
    return NextResponse.json({ ok: false, error: 'Query is required' }, { status: 400 })
  }

  let criteria: SearchCriteria = {}

  try {
    criteria = await parseSearchQuery(query)
  } catch {
    // Fall back to keyword-only search if AI parsing fails
  }

  // Build Prisma filter
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = { isDuplicate: false }

  if (criteria.desiredCategories?.length) {
    where.category = { in: criteria.desiredCategories as Category[] }
  }

  if (criteria.transactionType) {
    where.transactionType = criteria.transactionType as TransactionType
  }

  if (criteria.borough) {
    where.borough = { contains: criteria.borough, mode: 'insensitive' }
  }

  // Fetch candidates — we post-filter and rank in memory for flexibility
  const candidates = await prisma.extractedOpportunity.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 200,
  })

  const ranked = rankOpportunities(candidates, criteria, query)
  const top = ranked.slice(0, 20)

  // Save search query
  await prisma.searchQuery.create({
    data: {
      queryText: query,
      parsedCriteriaJson: criteria as object,
      resultCount: top.length,
    },
  })

  return NextResponse.json({
    ok: true,
    query,
    criteria,
    resultCount: top.length,
    results: top.map((r: RankedOpportunity) => ({
      ...r.opportunity,
      matchScore: r.score,
      matchReasons: r.matchReasons,
    })),
    note: top.length === 0
      ? 'No strong matches found in your synced inbox data. Run a sync first if you have not already.'
      : undefined,
  })
}
