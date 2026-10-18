// Phase X.4 — one-time catch-up sweep on records that already have a
// streetEasyId (typically from hotsheet sync) but have never been
// status-checked (streetEasyCheckedAt IS NULL). Each call is 1 RapidAPI
// hit (the SE ID is already known, so no address search).
//
// Manual-run, batched. Default batch size 200; override as first arg.
// A dry run (the batch it would check, no API calls) unless --apply:
//   npx tsx scripts/catch-up-sweep.ts --apply 200
//
// Budget gate (lib/streetEasySync.ts:checkAndIncrementQuota) hard-pauses
// at 4900/5000 calls/month. QuotaExhaustedError caught here for a clean
// exit when the cap is hit mid-batch.

import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { syncOpportunityStatus, QuotaExhaustedError } from '../lib/streetEasySync'
import { maintenanceApply, scriptArgs } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): a dry run unless --apply, and --apply
// on a database that isn't *_perf / *_test also needs --i-mean-live.
const APPLY = maintenanceApply(process.env.DATABASE_URL, 'scripts/catch-up-sweep.ts (DATABASE_URL)')

const BATCH      = parseInt(scriptArgs()[0] ?? '200', 10)
const SLEEP_MS   = 250
const TIMEOUT_MS = 30_000

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

// Cap each syncOpportunityStatus call so a hung Prisma/network call can't
// silently stall the entire batch (3,000-record run on 2026-05-28 stalled
// at 868 after a Prisma connection error). Rejection bubbles to the
// existing per-record try/catch, which counts the error and continues.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`record timeout after ${ms}ms`)), ms)
    ),
  ])
}

async function main() {
  const records = await prisma.extractedOpportunity.findMany({
    where: {
      streetEasyId:        { not: null },
      streetEasyCheckedAt: null,
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  })

  console.log(`[catch-up-sweep] ${APPLY ? 'Processing' : 'Dry run:'} ${records.length} never-checked records (batch size ${BATCH})`)
  if (!APPLY) {
    console.log('[catch-up-sweep] Nothing checked or written. Re-run with --apply to check them on StreetEasy (1 RapidAPI call each).')
    await prisma.$disconnect()
    return
  }
  let updated = 0, unchanged = 0, errors = 0

  for (const r of records) {
    try {
      const result = await withTimeout(syncOpportunityStatus(r.id), TIMEOUT_MS)
      if (result.updated) updated++; else unchanged++
    } catch (e) {
      if (e instanceof QuotaExhaustedError) {
        console.error(`[catch-up-sweep] QUOTA HIT — stopping. Processed ${updated + unchanged + errors} of ${records.length}.`)
        break
      }
      errors++
      console.error(`[catch-up-sweep] Error on ${r.id}:`, (e as Error).message)
    }
    await sleep(SLEEP_MS)
  }

  console.log(`[catch-up-sweep] Done: updated=${updated} unchanged=${unchanged} errors=${errors}`)
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
