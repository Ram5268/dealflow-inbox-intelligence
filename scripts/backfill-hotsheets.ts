// Backfill all StreetEasy hotsheets from 90 days ago up to yesterday.
// Run: npx tsx --no-cache scripts/backfill-hotsheets.ts --apply   (without --apply: a dry run listing the days)
//
// Fetches both sale + rental hotsheets for every day.
// Already-stored listings are updated (not duplicated) via streetEasyId upsert.
// Expect ~20-25 min to complete (90 days × ~20 pages/day × 400ms delay).

import { runHotsheetSync } from '../lib/streetEasyHotsheet'
import { prisma } from '../lib/prisma'
import { maintenanceApply } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): a dry run unless --apply, and --apply
// on a database that isn't *_perf / *_test also needs --i-mean-live.
// The dry run fetches nothing (no ScrapingBee calls).
const APPLY = maintenanceApply(process.env.DATABASE_URL, 'scripts/backfill-hotsheets.ts (DATABASE_URL)')

async function main() {
  const today    = new Date()
  const end      = new Date(today)
  end.setDate(end.getDate() - 1)        // yesterday

  const start    = new Date(today)
  start.setDate(start.getDate() - 90)   // 90 days ago

  // Build list of dates oldest → newest
  const dates: string[] = []
  const cur = new Date(start)
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10))
    cur.setDate(cur.getDate() + 1)
  }

  console.log(`\n${APPLY ? 'Backfilling' : 'Dry run: would backfill'} ${dates.length} days: ${dates[0]} → ${dates[dates.length - 1]}`)
  if (!APPLY) {
    console.log('Nothing fetched or saved. Re-run with --apply to scrape them through ScrapingBee and save the listings (~20-30 minutes).')
    return
  }
  console.log('This will take ~20-30 minutes. Do not interrupt.\n')

  let totalSales   = 0
  let totalRentals = 0
  let totalMatches = 0
  let failed       = 0

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i]
    const pct  = Math.round(((i + 1) / dates.length) * 100)

    try {
      const result = await runHotsheetSync(date)
      totalSales   += result.sales
      totalRentals += result.rentals
      totalMatches += result.matches
      process.stdout.write(`\r[${pct}%] ${date} — ${result.sales} new sales, ${result.rentals} new rentals`)
    } catch (err) {
      failed++
      process.stdout.write(`\r[${pct}%] ${date} — FAILED: ${(err as Error).message.slice(0, 60)}`)
    }

    // Polite delay between days (pages already have their own 400ms delay)
    if (i < dates.length - 1) await new Promise(r => setTimeout(r, 800))
  }

  console.log(`\n\n✅ Backfill complete`)
  console.log(`   New sale listings:   ${totalSales}`)
  console.log(`   New rental listings: ${totalRentals}`)
  console.log(`   Buyer matches found: ${totalMatches}`)
  console.log(`   Failed dates:        ${failed}`)

  // Summary of what's now in DB
  const [saleCount, rentalCount] = await Promise.all([
    prisma.extractedOpportunity.count({ where: { category: 'ACTIVE_SALE_LISTING', streetEasyId: { not: null } } }),
    prisma.extractedOpportunity.count({ where: { category: 'RENTAL_LISTING',      streetEasyId: { not: null } } }),
  ])
  console.log(`\n   Total sale listings with SE ID in DB:   ${saleCount}`)
  console.log(`   Total rental listings with SE ID in DB: ${rentalCount}`)
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
