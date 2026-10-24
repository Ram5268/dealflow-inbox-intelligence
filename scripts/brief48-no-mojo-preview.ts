// Brief 48 (PR 8, item 4.1): how many CRM leads have no Mojo ID today, and what the next
// morning copy would do with them now that it copies them (under the stand-in key
// 'crm-' + the CRM lead id), before or after this PR merges.
//
//   DATABASE_URL=<DealFlow> DATABASE_URL_CRM_RO=<CRM, read-only> npx tsx scripts/brief48-no-mojo-preview.ts
//
// It counts the CRM's leads by Mojo ID (none, empty, and any real one that starts like a
// stand-in key, which should be 0), the DealFlow rows already under a stand-in key, and
// plans tomorrow's copy with the copy's own code (readCrmLeads, mapLead, planSync): new
// sellers with and without a Mojo ID, sellers on their own row, rows re-keyed by their CRM
// lead id, rows newly marked as duplicates, and leads left alone because test data or
// another organization holds their Mojo ID. Counts only: no name, number, address or id
// is printed. It uses the DATABASE_URL and DATABASE_URL_CRM_RO in its environment only
// (it doesn't load .env).
//
// Read only, enforced by the databases (engineering precaution): DealFlow's connection is
// opened with default_transaction_read_only = on, checked before the first read; the CRM
// link runs every statement in a READ ONLY transaction. There is no --apply.
import { Pool } from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { maintenanceApply } from '../lib/dbGuard'
import type { ExistingRow } from '../lib/crm-sync/plan'
import type { CrmMojoCounts, RowSource } from '../lib/crm-sync/noMojoPreview'

// Brief 41.2 (engineering precaution): every script calls a guard before anything else.
// This one never writes, so --apply is refused in main().
const APPLY = maintenanceApply(process.env.DATABASE_URL, 'scripts/brief48-no-mojo-preview.ts (DATABASE_URL)')

// A refusal of this script's own: its message names no data, so it is printed.
class Refused extends Error {}

async function preview(db: PrismaClient) {
  const [session] = await db.$queryRawUnsafe<{ transaction_read_only: string }[]>('SHOW transaction_read_only')
  if (session?.transaction_read_only !== 'on') throw new Refused('the connection is not read only; nothing was read')
  // lib/prisma reuses a client already on globalThis, so the copy's code imported below
  // reads through this read-only connection; checked before any of it runs.
  ;(globalThis as unknown as { prisma?: PrismaClient }).prisma = db
  if ((await import('../lib/prisma')).prisma !== db) throw new Refused('the copy code is not on the read-only connection; nothing was read')
  const { ORG_SLUG, EXISTING_SQL } = await import('../lib/crm-sync/runSync')
  const { readCrmLeads } = await import('../lib/crm-sync/crmReader')
  const { closeCrmPool, crmQuery } = await import('../lib/crm-sync/roClient')
  const { mapLead } = await import('../lib/crm-sync/mapLead')
  const { planSync } = await import('../lib/crm-sync/plan')
  const { TAKEN_SQL } = await import('../lib/crm-sync/crmWins')
  const { CRM_MOJO_COUNTS_SQL, DF_ROW_SOURCES_SQL, DF_STAND_IN_COUNT_SQL, noMojoPlanCounts } = await import('../lib/crm-sync/noMojoPreview')

  try {
    const org = await db.organization.findUniqueOrThrow({ where: { slug: ORG_SLUG }, select: { id: true } })
    const [crm] = await crmQuery<CrmMojoCounts>(CRM_MOJO_COUNTS_SQL, [ORG_SLUG])
    const [{ n: dealflowStandInRows }] = await db.$queryRawUnsafe<{ n: number }[]>(DF_STAND_IN_COUNT_SQL, org.id)
    const existing = await db.$queryRawUnsafe<ExistingRow[]>(EXISTING_SQL, org.id)
    const plan = planSync((await readCrmLeads(ORG_SLUG)).map(mapLead), existing)
    const taken = new Set((await db.$queryRawUnsafe<Array<{ mojoId: string }>>(TAKEN_SQL, org.id)).map(r => r.mojoId))
    const sources = new Map((await db.$queryRawUnsafe<Array<RowSource & { id: string }>>(DF_ROW_SOURCES_SQL, org.id)).map(r => [r.id, r]))
    console.log(JSON.stringify({
      crm,
      dealflowStandInRows,
      nextCopy: noMojoPlanCounts(plan, taken, sources, existing),
    }, null, 2))
  } finally {
    await closeCrmPool()
  }
}

async function main() {
  if (APPLY) {
    console.error('This script only reads: it has no --apply.')
    process.exitCode = 2
    return
  }
  const db = new PrismaClient({
    adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL, options: '-c default_transaction_read_only=on' })),
  })
  try {
    await preview(db)
  } finally {
    await db.$disconnect()
  }
}

main().catch(e => {
  // Otherwise the class name (and Prisma's error code) only: a message could quote a query.
  const code = (e as { code?: unknown } | null)?.code
  const why = e instanceof Refused ? e.message : `${e instanceof Error ? e.constructor.name : 'unknown'}${typeof code === 'string' ? ` ${code}` : ''}`
  console.error(`Failed (${why}). Nothing was written.`)
  process.exitCode = 1
})
