// Phase X.3 — historical SE ID backfill for email-extracted supply records
// that predate the X.1 auto-match. Iterates oldest-first, calls
// findListingByAddress, and persists the match if found.
//
// Manual-run, batched. Default batch size 100; override as the first arg:
//   npx tsx scripts/backfill-se-ids.ts 100
//
// Cost: 1-3 RapidAPI calls per record (one per area search attempt). Budget
// gate (lib/streetEasySync.ts:checkAndIncrementQuota) hard-pauses at
// 4900/5000 calls/month and throws QuotaExhaustedError; this script catches
// that and exits cleanly so the run doesn't blow past the cap.

import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { findListingByAddress, QuotaExhaustedError } from '../lib/streetEasySync'
import { SUPPLY_SALE, SUPPLY_RENTAL } from '../lib/domain/Categories'

const SUPPLY     = [...SUPPLY_SALE, ...SUPPLY_RENTAL]
const RENTAL_SET = new Set<string>(SUPPLY_RENTAL)
const BATCH      = parseInt(process.argv[2] ?? '100', 10)
const SLEEP_MS   = 500

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  const records = await prisma.extractedOpportunity.findMany({
    where: {
      streetEasyId: null,
      address:      { not: null },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      category:     { in: SUPPLY as any },
    },
    select: { id: true, address: true, neighborhood: true, borough: true, category: true },
    // Newest-first: maximizes hit rate. Stale extracts burn API calls
    // for zero matches.
    orderBy: { createdAt: 'desc' },
    take: BATCH,
  })

  console.log(`[backfill-se-ids] Processing ${records.length} records (batch size ${BATCH})`)
  let matched = 0, skipped = 0, errors = 0

  for (const r of records) {
    try {
      const isRental = RENTAL_SET.has(r.category)
      const match = await findListingByAddress(
        r.address!,
        r.neighborhood ?? null,
        isRental ? 'rental' : 'sale',
        r.borough ?? null,
      )
      if (match) {
        await prisma.extractedOpportunity.update({
          where: { id: r.id },
          data: {
            streetEasyId:        match.id,
            streetEasyStatus:    match.status ?? 'active',
            streetEasyCheckedAt: new Date(),
          },
        })
        matched++
      } else {
        skipped++
      }
    } catch (e) {
      if (e instanceof QuotaExhaustedError) {
        console.error(`[backfill-se-ids] QUOTA HIT — stopping. Processed ${matched + skipped + errors} of ${records.length}.`)
        break
      }
      errors++
      console.error(`[backfill-se-ids] Error on ${r.id}:`, (e as Error).message)
    }
    await sleep(SLEEP_MS)
  }

  console.log(`[backfill-se-ids] Done: matched=${matched} skipped=${skipped} errors=${errors}`)
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
