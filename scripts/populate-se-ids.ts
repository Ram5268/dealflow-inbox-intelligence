// Populates streetEasyId for all active listings that don't have one yet.
// Uses the StreetEasy RapidAPI to find each listing by address.
// Run: DATABASE_URL="..." RAPIDAPI_KEY="..." npx tsx --no-cache scripts/populate-se-ids.ts --apply
// (without --apply: a dry run that only counts them, no API calls)
import { prisma } from '../lib/prisma'
import { syncOpportunityStatus } from '../lib/streetEasySync'
import { maintenanceApply } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): a dry run unless --apply, and --apply
// on a database that isn't *_perf / *_test also needs --i-mean-live.
const APPLY = maintenanceApply(process.env.DATABASE_URL, 'scripts/populate-se-ids.ts (DATABASE_URL)')

const BATCH = 5   // concurrent lookups per batch
const DELAY = 400 // ms between batches (rate limit)

async function main() {
  const records = await prisma.extractedOpportunity.findMany({
    where: {
      processingStatus: 'active',
      streetEasyId: null,
      address: { not: null },
      category: {
        in: [
          'ACTIVE_SALE_LISTING','RENTAL_LISTING','COMING_SOON_SALE','COMING_SOON_RENTAL',
          'OFF_MARKET_SALE','BACK_ON_MARKET','PRICE_DROP','OPEN_HOUSE',
          'DEVELOPMENT_INVENTORY','COMING_SOON_DEVELOPMENT','SPONSOR_UNIT',
        ],
      },
    },
    select: { id: true, address: true, neighborhood: true },
    orderBy: { createdAt: 'desc' },
  })

  console.log(`\nFound ${records.length} records missing streetEasyId\n`)
  if (records.length === 0) { console.log('Nothing to do.'); return }
  if (!APPLY) { console.log('Dry run: nothing looked up or written. Re-run with --apply to look them up on StreetEasy (RapidAPI calls).'); return }

  let found = 0, notFound = 0, failed = 0

  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH)

    const results = await Promise.allSettled(
      batch.map(r => syncOpportunityStatus(r.id))
    )

    for (let j = 0; j < results.length; j++) {
      const r = results[j]
      if (r.status === 'rejected') {
        failed++
      } else if (r.value.streetEasyStatus === 'unknown' || r.value.streetEasyStatus === null) {
        notFound++
      } else {
        found++
      }
    }

    const done = Math.min(i + BATCH, records.length)
    process.stdout.write(`\r  ${found} linked, ${notFound} not found on SE, ${failed} errors — ${done}/${records.length}`)
    await new Promise(r => setTimeout(r, DELAY))
  }

  console.log(`\n\n✅ Done — ${found} listings linked to StreetEasy, ${notFound} not found, ${failed} errors`)
}

main().catch(console.error).finally(() => prisma.$disconnect())
