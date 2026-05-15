export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const session = await prisma.chatSession.update({
    where: { id },
    data: { archived: body.archived ?? true },
  })
  return NextResponse.json({ ok: true, session })
}
