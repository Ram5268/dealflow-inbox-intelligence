// Brief 41 (H8) — erase stored PLUTO owner names.
//
// DealFlow used to save PLUTO's `ownername` in NycParcelCache and to write it
// into the property-type reason ("…+ownername_corp:<name>") on the cache and
// on ExtractedOpportunity. The code no longer does either; this clears what is
// already stored. A production data step: run it only with Ryan's OK. It never
// prints a name, only counts.
//
// It also counts (never changes) stored listing titles and summaries that
// mention estate, probate, divorce, a death and the like (Brief 41, H9), and
// chat messages whose saved deal cards still carry an owner name, for Ryan to
// decide on.
//
//   npx tsx scripts/brief41-null-ownernames.ts            # dry run (default): counts only
//   npx tsx scripts/brief41-null-ownernames.ts --apply    # null the names, strip them from reasons
import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { maintenanceApply } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): --apply on a live database also needs --i-mean-live.
const APPLY = maintenanceApply(process.env.DATABASE_URL, 'scripts/brief41-null-ownernames.ts (DATABASE_URL)')

// Roughly the words lib/extraction/personalCircumstances.ts filters (Postgres
// regex; "estate" only when not "real estate").
const PERSONAL_SQL =
  '\\m(probat\\w*|divorc\\w*|ex-(wife|husband|spouse)|passed\\s+away|deceased|deaths?|died|dies|funeral|widow\\w*|heirs?|inherit\\w*|' +
  'executors?|executrix|(?<!real[ -])estates?|terminally ill|illness|cancer|hospice|nursing home|assisted living|dementia|alzheimer\\w*)\\M'

async function counts() {
  const [row] = await prisma.$queryRaw<Array<{ owners: number; cacheReasons: number; oppReasons: number; chatCards: number; personal: number; personalTest: number }>>`
    SELECT
      (SELECT COUNT(*)::int FROM "NycParcelCache" WHERE ownername IS NOT NULL) AS owners,
      (SELECT COUNT(*)::int FROM "NycParcelCache" WHERE "propertyTypeReason" LIKE '%ownername_corp:%') AS "cacheReasons",
      (SELECT COUNT(*)::int FROM "ExtractedOpportunity" WHERE "propertyTypeReason" LIKE '%ownername_corp:%') AS "oppReasons",
      (SELECT COUNT(*)::int FROM "ChatMessage" WHERE "dealsJson"::text LIKE '%ownername_corp:%') AS "chatCards",
      (SELECT COUNT(*)::int FROM "ExtractedOpportunity" WHERE "extractedSummary" ~* ${PERSONAL_SQL} OR "extractedTitle" ~* ${PERSONAL_SQL}) AS personal,
      (SELECT COUNT(*)::int FROM "ExtractedOpportunity" WHERE ("extractedSummary" ~* ${PERSONAL_SQL} OR "extractedTitle" ~* ${PERSONAL_SQL}) AND "isTestData") AS "personalTest"`
  return {
    parcelsWithOwnerName: row.owners,
    cacheReasonsWithName: row.cacheReasons,
    opportunityReasonsWithName: row.oppReasons,
    chatMessagesWithOwnerNameInSavedCards: row.chatCards, // counted only, never changed here
    listingsMentioningPersonalCircumstances: row.personal, // title or summary; counted only, never changed here
    ofWhichTestData: row.personalTest,
  }
}

async function main() {
  const apply = APPLY
  const before = await counts()
  console.log(JSON.stringify({ before }, null, 2))
  if (!apply) {
    console.log('Dry run: nothing changed. Re-run with --apply to clear these.')
    return
  }
  const [owners, cacheReasons, oppReasons] = await prisma.$transaction([
    prisma.$executeRaw`UPDATE "NycParcelCache" SET ownername = NULL WHERE ownername IS NOT NULL`,
    // The name is always the end of the note ("+" included).
    prisma.$executeRaw`UPDATE "NycParcelCache" SET "propertyTypeReason" = regexp_replace("propertyTypeReason", 'ownername_corp:.*$', 'ownername_corp') WHERE "propertyTypeReason" LIKE '%ownername_corp:%'`,
    prisma.$executeRaw`UPDATE "ExtractedOpportunity" SET "propertyTypeReason" = regexp_replace("propertyTypeReason", 'ownername_corp:.*$', 'ownername_corp') WHERE "propertyTypeReason" LIKE '%ownername_corp:%'`,
  ])
  console.log(JSON.stringify({ updated: { owners, cacheReasons, oppReasons }, after: await counts() }, null, 2))
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
