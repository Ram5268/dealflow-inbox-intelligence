// Brief 41 (H8) — erase stored PLUTO owner names.
//
// DealFlow used to save PLUTO's `ownername` in NycParcelCache and to write it
// into the property-type reason ("…+ownername_corp:<name>") on the cache and
// on ExtractedOpportunity. The code no longer does either; this clears what is
// already stored. A production data step: run it only with Ryan's OK. It never
// prints a name, only counts.
//
//   npx tsx scripts/brief41-null-ownernames.ts            # dry run (default): counts only
//   npx tsx scripts/brief41-null-ownernames.ts --apply    # null the names, strip them from reasons
import 'dotenv/config'
import { prisma } from '../lib/prisma'

async function counts() {
  const [row] = await prisma.$queryRaw<Array<{ owners: number; cacheReasons: number; oppReasons: number }>>`
    SELECT
      (SELECT COUNT(*)::int FROM "NycParcelCache" WHERE ownername IS NOT NULL) AS owners,
      (SELECT COUNT(*)::int FROM "NycParcelCache" WHERE "propertyTypeReason" LIKE '%ownername_corp:%') AS "cacheReasons",
      (SELECT COUNT(*)::int FROM "ExtractedOpportunity" WHERE "propertyTypeReason" LIKE '%ownername_corp:%') AS "oppReasons"`
  return { parcelsWithOwnerName: row.owners, cacheReasonsWithName: row.cacheReasons, opportunityReasonsWithName: row.oppReasons }
}

async function main() {
  const apply = process.argv.includes('--apply')
  const before = await counts()
  console.log(JSON.stringify({ before }, null, 2))
  if (!apply) {
    console.log('Dry run: nothing changed. Re-run with --apply to clear these.')
    return
  }
  const [owners, cacheReasons, oppReasons] = await prisma.$transaction([
    prisma.$executeRaw`UPDATE "NycParcelCache" SET ownername = NULL WHERE ownername IS NOT NULL`,
    prisma.$executeRaw`UPDATE "NycParcelCache" SET "propertyTypeReason" = regexp_replace("propertyTypeReason", 'ownername_corp:[^+]*', 'ownername_corp', 'g') WHERE "propertyTypeReason" LIKE '%ownername_corp:%'`,
    prisma.$executeRaw`UPDATE "ExtractedOpportunity" SET "propertyTypeReason" = regexp_replace("propertyTypeReason", 'ownername_corp:[^+]*', 'ownername_corp', 'g') WHERE "propertyTypeReason" LIKE '%ownername_corp:%'`,
  ])
  console.log(JSON.stringify({ updated: { owners, cacheReasons, oppReasons }, after: await counts() }, null, 2))
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
