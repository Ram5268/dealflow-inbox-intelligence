// Enables the new retrieval pipeline (Phase 8).
// Run once: DATABASE_URL="..." npx tsx --no-cache scripts/enable-new-pipeline.ts --apply
// (without --apply: a dry run that only shows the flags)
import { prisma } from '../lib/prisma'
import { maintenanceApply } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): a dry run unless --apply, and --apply
// on a database that isn't *_perf / *_test also needs --i-mean-live.
const APPLY = maintenanceApply(process.env.DATABASE_URL, 'scripts/enable-new-pipeline.ts (DATABASE_URL)')

async function main() {
  const flags = [
    'USE_NEW_RETRIEVAL_PIPELINE',
    'USE_STRUCTURED_INGESTION_PIPELINE',
    'USE_LLM_QUERY_PARSER',
    'USE_REVIEW_QUEUE_ENFORCEMENT',
    'USE_PROPERTY_RESOLUTION',
  ]

  if (!APPLY) {
    const current = new Map((await prisma.featureFlag.findMany({ where: { id: { in: flags } } })).map(f => [f.id, f.enabled]))
    for (const id of flags) console.log(`  ${id}: ${current.has(id) ? (current.get(id) ? 'on' : 'off') : 'missing'}`)
    console.log('Dry run: nothing changed. --apply creates the missing flags (off), then switches USE_NEW_RETRIEVAL_PIPELINE on.')
    return
  }

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
