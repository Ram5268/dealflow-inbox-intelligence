export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const [count, latest] = await Promise.all([
    prisma.mojoContact.count(),
    prisma.mojoContact.findFirst({ orderBy: { syncedAt: 'desc' }, select: { syncedAt: true } }),
  ])
  return NextResponse.json({ count, lastSync: latest?.syncedAt ?? null })
}
