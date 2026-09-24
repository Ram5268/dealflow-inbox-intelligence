// Brief 33 — inject realistic OPERATIONAL variance into seed data so the ranker's
// freshness + cooldown features (which exist to exploit exactly this) can spread
// the queue. The Brief 32 regen created every Match at one instant and no seed
// contact has call history, so those features saturate at 1.0 for everyone.
//
// This mutates only temporal/operational columns (Match.createdAt for
// mojo-involving matches; MojoContact.lastCalled/lastDialDate). It does NOT touch
// scoring inputs — the scorer's recency reads ExtractedOpportunity.createdAt, not
// Match.createdAt. Idempotent enough for re-runs (re-randomizes).
//
// Run:  npx tsx scripts/seed-brief33-operational-variance.ts
import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { getCurrentOrgId } from '../lib/auth/orgContext'

async function main() {
  const orgId = await getCurrentOrgId()

  // Spread mojo-involving Match.createdAt across the last 0-45 days.
  const m = await prisma.$executeRawUnsafe(`
    UPDATE "Match"
    SET "createdAt" = NOW() - (random() * 45 || ' days')::interval
    WHERE "organizationId" = $1
      AND ("opportunityType" = 'contact' OR "counterpartType" = 'mojo')
  `, orgId)
  console.log(`Match.createdAt spread over 0-45d: ${m} rows`)

  // Give ~55% of seed contacts call history (0-120 days ago); leave ~45% never-called.
  const c = await prisma.$executeRawUnsafe(`
    UPDATE "MojoContact"
    SET "lastDialDate" = NOW() - (random() * 120 || ' days')::interval
    WHERE "organizationId" = $1 AND "isTestData" = true AND random() < 0.55
  `, orgId)
  console.log(`MojoContact.lastDialDate set on ~55%: ${c} rows`)

  await prisma.$disconnect()
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
