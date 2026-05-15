export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { Category, TransactionType } from '@prisma/client'

export async function GET(req: NextRequest) {
  const s = req.nextUrl.searchParams

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = { isDuplicate: false }

  if (s.get('category')) where.category = s.get('category') as Category
  if (s.get('transactionType')) where.transactionType = s.get('transactionType') as TransactionType
  if (s.get('borough')) where.borough = { contains: s.get('borough'), mode: 'insensitive' }
  if (s.get('neighborhood')) where.neighborhood = { contains: s.get('neighborhood'), mode: 'insensitive' }
  if (s.get('propertyType')) where.propertyType = { contains: s.get('propertyType'), mode: 'insensitive' }
  if (s.get('sourceBrokerage')) where.sourceBrokerage = { contains: s.get('sourceBrokerage'), mode: 'insensitive' }

  const maxPrice = s.get('maxPrice') ? parseFloat(s.get('maxPrice')!) : null
  const minPrice = s.get('minPrice') ? parseFloat(s.get('minPrice')!) : null
  if (maxPrice != null) where.OR = [{ price: { lte: maxPrice } }, { maxPrice: { lte: maxPrice } }]
  if (minPrice != null) where.price = { ...(where.price ?? {}), gte: minPrice }

  const [opportunities, total] = await Promise.all([
    prisma.extractedOpportunity.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.extractedOpportunity.count({ where }),
  ])

  return NextResponse.json({ opportunities, total })
}
