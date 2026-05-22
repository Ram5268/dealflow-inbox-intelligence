// Run this locally (not on Railway) to backfill StreetEasy hotsheets.
// Your home IP bypasses StreetEasy bot detection. Railway's IP triggers it.
//
// Usage:
//   npx tsx scripts/backfill-hotsheets-local.ts
//   npx tsx scripts/backfill-hotsheets-local.ts --days 30
//   npx tsx scripts/backfill-hotsheets-local.ts --start 2026-03-01 --end 2026-05-01

import 'dotenv/config'
import { runHotsheetSync } from '../lib/streetEasyHotsheet'

const DELAY_MS = 45_000  // 45 seconds between dates — looks like a normal user

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

function parseDateArg(args: string[], flag: string): string | null {
  const i = args.indexOf(flag)
  return i !== -1 && args[i + 1] ? args[i + 1] : null
}

async function main() {
  const args = process.argv.slice(2)
  const daysArg  = parseDateArg(args, '--days')
  const startArg = parseDateArg(args, '--start')
  const endArg   = parseDateArg(args, '--end')

  const dates: string[] = []

  if (startArg && endArg) {
    const start = new Date(startArg)
    const end   = new Date(endArg)
    for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10))
    }
  } else {
    const days  = daysArg ? Math.min(parseInt(daysArg), 90) : 90
    const today = new Date()
    for (let i = days; i >= 1; i--) {
      const d = new Date(today)
      d.setDate(d.getDate() - i)
      dates.push(d.toISOString().slice(0, 10))
    }
  }

  console.log(`[Backfill] ${dates.length} dates to process`)
  console.log(`[Backfill] First: ${dates[0]}  Last: ${dates[dates.length - 1]}`)
  console.log(`[Backfill] Estimated time: ~${Math.round(dates.length * DELAY_MS / 60000)} minutes\n`)

  let totalSales = 0, totalRentals = 0, failed = 0

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i]
    try {
      const result = await runHotsheetSync(date)
      totalSales   += result.sales
      totalRentals += result.rentals
      const pct = Math.round(((i + 1) / dates.length) * 100)
      console.log(`[${pct}%] ${date} — ${result.sales} sales, ${result.rentals} rentals (running: ${totalSales}S / ${totalRentals}R)`)
    } catch (err) {
      failed++
      console.error(`[Backfill] FAILED ${date}:`, (err as Error).message)
    }

    if (i < dates.length - 1) {
      process.stdout.write(`  waiting ${DELAY_MS / 1000}s...`)
      await sleep(DELAY_MS)
      process.stdout.write(' done\n')
    }
  }

  console.log(`\n[Backfill] Complete — ${totalSales} sales, ${totalRentals} rentals, ${failed} failed dates`)
  process.exit(0)
}

main().catch(err => { console.error(err); process.exit(1) })
