// Generates embeddings for all ExtractedOpportunity records that are missing them.
// Run this once to make your full dataset searchable via semantic search.
// A dry run (the count, no OpenAI calls) unless --apply.
import { prisma } from '../lib/prisma'
import { embedText, buildOpportunityText } from '../lib/embeddings'
import { maintenanceApply } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): a dry run unless --apply, and --apply
// on a database that isn't *_perf / *_test also needs --i-mean-live.
const APPLY = maintenanceApply(process.env.DATABASE_URL, 'scripts/embed-missing.ts (DATABASE_URL)')

async function main() {
  // Find all IDs missing embeddings via raw query (embedding is Unsupported type)
  const missing = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "ExtractedOpportunity"
    WHERE embedding IS NULL
      AND "processingStatus" NOT IN ('rejected', 'duplicate')
    ORDER BY "createdAt" DESC
  `

  console.log(`Found ${missing.length} opportunities missing embeddings.`)
  if (missing.length === 0) { console.log('Nothing to do.'); return }
  if (!APPLY) { console.log('Dry run: nothing embedded. Re-run with --apply to embed them (OpenAI calls).'); return }

  // Fetch full records in batches of 50
  const BATCH = 50
  let done = 0
  let failed = 0

  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH).map(r => r.id)
    const opps = await prisma.extractedOpportunity.findMany({
      where: { id: { in: batch } },
      select: {
        id: true, category: true, address: true, neighborhood: true, borough: true,
        price: true, minPrice: true, maxPrice: true, beds: true, baths: true,
        propertyType: true, extractedTitle: true, extractedSummary: true,
        sourceBrokerage: true, sourceAgentName: true, availabilityDate: true,
        units: true,
      },
    })

    for (const opp of opps) {
      try {
        const text = buildOpportunityText(opp)
        const vector = await embedText(text)
        const pgVector = `[${vector.join(',')}]`
        await prisma.$executeRaw`
          UPDATE "ExtractedOpportunity"
          SET embedding = ${pgVector}::vector
          WHERE id = ${opp.id}
        `
        done++
      } catch {
        failed++
      }
      process.stdout.write(`\r  ${done} embedded, ${failed} failed — ${missing.length - done - failed} remaining`)
      await new Promise(r => setTimeout(r, 80))
    }
  }

  console.log(`\n\n✅ Done — ${done} embeddings generated, ${failed} failed.`)
}

main().catch(console.error).finally(() => prisma.$disconnect())
