export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { buildOpportunityText, upsertOpportunityEmbedding } from '@/lib/embeddings'
import { maintenanceEnabled, MAINTENANCE_OFF_BODY } from '@/lib/config/maintenance'

export const maxDuration = 300

// Maintenance route (Brief 41, H6): off unless MAINTENANCE_ENABLED=true.
export async function POST() {
  if (!maintenanceEnabled()) return NextResponse.json(MAINTENANCE_OFF_BODY, { status: 403 })
  const opps = await prisma.extractedOpportunity.findMany({
    where: { isDuplicate: false },
    select: {
      id: true, extractedTitle: true, extractedSummary: true, category: true,
      neighborhood: true, borough: true, address: true, propertyType: true,
      beds: true, baths: true, units: true, price: true, minPrice: true,
      maxPrice: true, sourceBrokerage: true, sourceAgentName: true, availabilityDate: true,
    },
  })

  console.log(`[EmbedAll] Embedding ${opps.length} opportunities...`)
  let done = 0
  let failed = 0

  for (const opp of opps) {
    try {
      const text = buildOpportunityText(opp)
      await upsertOpportunityEmbedding(opp.id, text)
      done++
      if (done % 10 === 0) console.log(`[EmbedAll] ${done}/${opps.length}`)
      // Respect OpenAI rate limits
      await new Promise(r => setTimeout(r, 100))
    } catch (e) {
      console.error(`[EmbedAll] Failed ${opp.id}:`, (e as Error).message)
      failed++
    }
  }

  console.log(`[EmbedAll] Done: ${done} embedded, ${failed} failed`)
  return NextResponse.json({ total: opps.length, done, failed })
}
