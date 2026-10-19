export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { limit } from '@/lib/spendGuard'
import OpenAI from 'openai'

const DAY_MS = 24 * 60 * 60 * 1000

export async function POST() {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  // Brief 43 PR 17 [engineering precaution]: DealFlow has no login [Ryan,
  // 2026-09-24] and the History drawer calls this on every open, so title at
  // most RETITLE_MAX_PER_CALL (default 20) chats per call, newest first: only
  // visible (unarchived) ones, updated in the last day, with a user message
  // (an empty chat can't be titled and would hold a slot forever).
  const sessions = await prisma.chatSession.findMany({
    where: {
      title: null,
      archived: false,
      updatedAt: { gte: new Date(Date.now() - DAY_MS) },
      messages: { some: { role: 'user' } },
    },
    orderBy: { updatedAt: 'desc' },
    take: limit('RETITLE_MAX_PER_CALL'),
    include: { messages: { orderBy: { createdAt: 'asc' }, take: 2 } },
  })

  let updated = 0
  for (const session of sessions) {
    const userMsg   = session.messages.find((m: { role: string }) => m.role === 'user')
    const assistMsg = session.messages.find((m: { role: string }) => m.role === 'assistant')
    if (!userMsg) continue

    try {
      const completion = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Generate a 4-7 word title that summarizes this real estate conversation. Title case, no punctuation at end, no quotes. Examples: "Brooklyn Buyer ISO Matches", "Coming Soon Under 2M", "Off Market Tribeca Search"' },
          { role: 'user', content: `User asked: ${userMsg.content.slice(0, 300)}\nAssistant replied: ${(assistMsg?.content ?? '').slice(0, 300)}` },
        ],
        max_tokens: 20,
        temperature: 0.3,
      })
      const title = completion.choices[0].message.content?.trim().replace(/^["']|["']$/g, '')
      if (title) {
        await prisma.chatSession.update({ where: { id: session.id }, data: { title } })
        updated++
      }
    } catch { /* non-fatal per session */ }
  }

  return NextResponse.json({ ok: true, updated })
}
