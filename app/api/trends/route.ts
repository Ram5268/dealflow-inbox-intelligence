import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const now = new Date()
  const ago7  = new Date(now.getTime() - 7  * 86400_000)
  const ago30 = new Date(now.getTime() - 30 * 86400_000)

  const [
    totalEmails, totalOpps,
    byCatRaw, brokerageRaw, neighborhoodRaw,
    last7Days, last30Days, last7DaysOpps,
  ] = await Promise.all([
    prisma.rawEmail.count(),
    prisma.extractedOpportunity.count({ where: { isDuplicate: false } }),
    prisma.extractedOpportunity.groupBy({ by: ['category'], _count: { category: true }, where: { isDuplicate: false } }),
    prisma.extractedOpportunity.groupBy({ by: ['sourceBrokerage'], _count: { sourceBrokerage: true }, where: { isDuplicate: false, sourceBrokerage: { not: null } } }),
    prisma.extractedOpportunity.groupBy({ by: ['neighborhood'], _count: { neighborhood: true }, where: { isDuplicate: false, neighborhood: { not: null } } }),
    prisma.rawEmail.count({ where: { receivedDateTime: { gte: ago7 } } }),
    prisma.rawEmail.count({ where: { receivedDateTime: { gte: ago30 } } }),
    prisma.extractedOpportunity.count({ where: { isDuplicate: false, createdAt: { gte: ago7 } } }),
  ])

  return NextResponse.json({
    totalEmails,
    totalOpps,
    byCategory: byCatRaw
      .sort((a, b) => b._count.category - a._count.category)
      .map(r => ({ category: r.category, count: r._count.category })),
    topBrokerages: brokerageRaw
      .sort((a, b) => b._count.sourceBrokerage - a._count.sourceBrokerage)
      .slice(0, 8)
      .map(r => ({ name: r.sourceBrokerage!, count: r._count.sourceBrokerage })),
    topNeighborhoods: neighborhoodRaw
      .sort((a, b) => b._count.neighborhood - a._count.neighborhood)
      .slice(0, 12)
      .map(r => ({ name: r.neighborhood!, count: r._count.neighborhood })),
    last7Days,
    last30Days,
    last7DaysOpps,
  })
}
