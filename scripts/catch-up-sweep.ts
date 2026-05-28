// Phase X.4 — one-time catch-up sweep on records that already have a
// streetEasyId (typically from hotsheet sync) but have never been
// status-checked (streetEasyCheckedAt IS NULL). Each call is 1 RapidAPI
// hit (the SE ID is already known, so no address search).
//
// Manual-run, batched. Default batch size 200; override as first arg:
//   npx tsx scripts/catch-up-sweep.ts 200
//
// Budget gate (lib/streetEasySync.ts:checkAndIncrementQuota) hard-pauses
// at 4900/5000 calls/month. QuotaExhaustedError caught here for a clean
// exit when the cap is hit mid-batch.

import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { syncOpportunityStatus, QuotaExhaustedError } from '../lib/streetEasySync'

const BATCH    = parseInt(process.argv[2] ?? '200', 10)
const SLEEP_MS = 250

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  const prisma = new PrismaClient()
  const records = await prisma.extractedOpportunity.findMany({
    where: {
      streetEasyId:        { not: null },
      streetEasyCheckedAt: null,
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  })

  console.log(`[catch-up-sweep] Processing ${records.length} never-checked records (batch size ${BATCH})`)
  let updated = 0, unchanged = 0, errors = 0

  for (const r of records) {
    try {
      const result = await syncOpportunityStatus(r.id)
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
