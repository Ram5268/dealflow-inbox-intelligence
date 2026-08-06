export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isTestModeOnly } from '@/lib/config/testMode'

export async function GET() {
  // Read endpoint — in test mode report the gated state honestly to the dashboard.
  if (isTestModeOnly()) return NextResponse.json({ enabled: false, testMode: true, contactsVisible: 0 })
  const [count, latest] = await Promise.all([
    prisma.mojoContact.count(),
    prisma.mojoContact.findFirst({ orderBy: { syncedAt: 'desc' }, select: { syncedAt: true } }),
  ])
  return NextResponse.json({ count, lastSync: latest?.syncedAt ?? null })
}
