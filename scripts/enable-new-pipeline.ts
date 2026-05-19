// Enables the new retrieval pipeline (Phase 8).
// Run once: DATABASE_URL="..." npx tsx --no-cache scripts/enable-new-pipeline.ts
import { prisma } from '../lib/prisma'

async function main() {
  const flags = [
    'USE_NEW_RETRIEVAL_PIPELINE',
    'USE_STRUCTURED_INGESTION_PIPELINE',
    'USE_LLM_QUERY_PARSER',
    'USE_REVIEW_QUEUE_ENFORCEMENT',
    'USE_PROPERTY_RESOLUTION',
  ]

  // Seed all flags (disabled by default) then enable the retrieval pipeline
  for (const id of flags) {
    await prisma.featureFlag.upsert({
      where:  { id },
      update: {},
      create: { id, enabled: false },
    })
  }

  await prisma.featureFlag.update({
    where: { id: 'USE_NEW_RETRIEVAL_PIPELINE' },
    data:  { enabled: true },
  })

  const all = await prisma.featureFlag.findMany()
  console.log('\nFeature flags:')
  all.forEach(f => console.log(`  ${f.enabled ? '✅' : '⬜'} ${f.id}`))
}

main().catch(console.error).finally(() => prisma.$disconnect())
