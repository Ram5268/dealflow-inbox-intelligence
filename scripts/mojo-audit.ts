// Brief 7.2 (Fix #10) — one-command review of Mojo/Zapier ingestion health.
// Ryan runs this after any new list import. Prints five sections with console.table.
//
// Run: npx tsx scripts/mojo-audit.ts
//  (or: npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/mojo-audit.ts)
import 'dotenv/config'
import { prisma } from '../lib/prisma'

async function main() {
  // 1) Last 20 Zapier ingests ────────────────────────────────────────────────
  const ingests = await prisma.$queryRawUnsafe(
    `SELECT "receivedAt", "resultStatus", "resultReason", "resultContactId"
       FROM "zapier_ingest_log"
       ORDER BY "receivedAt" DESC
       LIMIT 20`,
  )
  console.log('\n=== 1. Last 20 Zapier ingests ===')
  console.table(ingests)

  // 2) Recent validation warnings ─────────────────────────────────────────────
  const warnings = await prisma.$queryRawUnsafe(
    `SELECT id, "fullName", "mojoList", metadata->'validationWarnings' AS "validationWarnings"
       FROM "MojoContact"
       WHERE jsonb_exists(metadata, 'validationWarnings')
       ORDER BY "createdAt" DESC
       LIMIT 30`,
  )
  console.log("\n=== 2. Recent validation warnings (last 30) ===")
  console.table(warnings)

  // 3) Unmapped-keys pattern ──────────────────────────────────────────────────
  const unmapped = await prisma.$queryRawUnsafe(
    `SELECT metadata->'unmapped' AS unmapped_keys, count(*)::int AS count
       FROM "MojoContact"
       WHERE jsonb_exists(metadata, 'unmapped')
       GROUP BY unmapped_keys
       ORDER BY count DESC
       LIMIT 10`,
  )
  console.log('\n=== 3. Unmapped keys pattern (top 10) ===')
  console.table(unmapped)

  // 4) Neighborhood coverage ──────────────────────────────────────────────────
  const total = await prisma.mojoContact.count()
  const populated = await prisma.mojoContact.count({ where: { neighborhood: { not: null } } })
  console.log('\n=== 4. Neighborhood coverage ===')
  console.table([{ total, populated, null: total - populated }])

  // 5) Intent distribution ────────────────────────────────────────────────────
  const byIntent = await prisma.mojoContact.groupBy({ by: ['intent'], _count: { _all: true } })
  console.log('\n=== 5. Intent distribution ===')
  console.table(byIntent.map(r => ({ intent: r.intent ?? '(null)', count: r._count._all })))
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
