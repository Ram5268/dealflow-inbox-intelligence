export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { z } from 'zod'

// Brief 2.5 — Drift interaction sink. The chat route returns an `interactionId`
// with every response; the client posts here when Ryan taps a result card
// (event:'click') or rates a response (event:'feedback'). Discriminated union
// so each event enforces exactly the fields it needs.
const clickSchema = z.object({
  interactionId: z.string().min(1),
  event:         z.literal('click'),
  cardId:        z.string().min(1),
  cardKind:      z.string().min(1),
  rank:          z.number().int(),
})

const feedbackSchema = z.object({
  interactionId: z.string().min(1),
  event:         z.literal('feedback'),
  vote:          z.enum(['helpful', 'wrong_result', 'missing_result']),
  note:          z.string().max(2000).optional(),
})

const bodySchema = z.discriminatedUnion('event', [clickSchema, feedbackSchema])

export async function POST(req: NextRequest) {
  try {
    const parsed = bodySchema.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.flatten() }, { status: 400 })
    }
    const b = parsed.data

    if (b.event === 'click') {
      await prisma.driftInteractionClick.create({
        data: {
          interactionId: b.interactionId,
          cardId:        b.cardId,
          cardKind:      b.cardKind,
          rank:          b.rank,
        },
      })
    } else {
      await prisma.driftInteractionFeedback.create({
        data: {
          interactionId: b.interactionId,
          vote:          b.vote,
          note:          b.note,
        },
      })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[DealFlow] /api/chat/interaction error:', err)
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
