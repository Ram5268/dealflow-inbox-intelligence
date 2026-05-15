export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(req: NextRequest) {
  const showArchived = req.nextUrl.searchParams.get('archived') === 'true'

  const sessions = await prisma.chatSession.findMany({
    where: { archived: showArchived ? true : { not: true } },
    orderBy: { updatedAt: 'desc' },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
        take: 2,
      },
    },
  })

  return NextResponse.json({
    sessions: sessions.map(s => ({
      id: s.id,
      title: s.title,
      archived: s.archived,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      preview: s.messages.find(m => m.role === 'assistant')?.content?.slice(0, 80) ?? '',
    })),
  })
}
