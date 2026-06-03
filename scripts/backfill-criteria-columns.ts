// Phase 4.0.7 — one-time backfill: fold the deprecated CriteriaProfile rows
// into the new ExtractedOpportunity criteria columns. CriteriaProfile is kept
// (not dropped) for one deploy as the rollback story.
import 'dotenv/config'
import { prisma } from '../lib/prisma'

async function main() {
  const before = await prisma.criteriaProfile.count()
  console.log(`CriteriaProfile rows to backfill: ${before}`)

  const updated = await prisma.$executeRawUnsafe(`
    UPDATE "ExtractedOpportunity" o
    SET "neighborhoods" = COALESCE(cp.neighborhoods, ARRAY[]::TEXT[]),
        "propertyTypes" = COALESCE(cp."propertyTypes", ARRAY[]::TEXT[]),
        "minBeds"       = cp."minBeds",
        "maxBeds"       = cp."maxBeds",
        "mustHaves"     = COALESCE(cp.notes, o."extractedSummary"),
        "criteriaActive"= cp.active
    FROM "CriteriaProfile" cp
    WHERE cp."opportunityId" = o.id;
  `)

  console.log(`Rows updated: ${updated}`)
  if (updated !== before) {
    console.warn(`⚠ updated (${updated}) != CriteriaProfile count (${before}). Some profiles may point at missing opportunities.`)
  }
  if (updated === 0) {
    console.error('No rows updated — expected at least 1. Investigate before proceeding.')
    process.exitCode = 1
  }
  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
