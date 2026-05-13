import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const record = await prisma.connectedMailbox.findUnique({
    where: { id: 'runtime-token' },
    select: { lastSyncAt: true, updatedAt: true },
  })

  if (!record?.lastSyncAt) {
    return NextResponse.json({ status: 'unknown', expiresAt: null, minutesLeft: null })
  }

  const minutesLeft = Math.floor((record.lastSyncAt.getTime() - Date.now()) / 60000)
  const status = minutesLeft <= 0 ? 'expired' : minutesLeft <= 10 ? 'expiring' : 'ok'

  return NextResponse.json({
    status,
    expiresAt: record.lastSyncAt.toISOString(),
    minutesLeft,
  })
}
