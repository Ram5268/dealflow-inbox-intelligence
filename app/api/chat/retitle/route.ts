import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import OpenAI from 'openai'

export async function POST() {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  const sessions = await prisma.chatSession.findMany({
    where: { title: null },
    include: { messages: { orderBy: { createdAt: 'asc' }, take: 2 } },
  })

  let updated = 0
  for (const session of sessions) {
    const userMsg   = session.messages.find(m => m.role === 'user')
    const assistMsg = session.messages.find(m => m.role === 'assistant')
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
