import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const sessions = await prisma.chatSession.findMany({
    orderBy: { updatedAt: 'desc' },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
        take: 2, // first user + first assistant for preview
      },
    },
  })

  return NextResponse.json({
    sessions: sessions.map(s => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      preview: s.messages.find(m => m.role === 'assistant')?.content?.slice(0, 80) ?? '',
    })),
  })
}
