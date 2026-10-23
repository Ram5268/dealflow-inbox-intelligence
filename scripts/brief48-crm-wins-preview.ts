// Brief 48 (PR 7): what turning the CRM_WINS switch on would change, before the executor
// turns it on (Brief 48 data step DS-4) or on any day after.
//
//   DATABASE_URL=<DealFlow> DATABASE_URL_CRM_RO=<CRM, read-only> npx tsx scripts/brief48-crm-wins-preview.ts
//
// It reads every CRM lead through DealFlow's read-only CRM link (lib/crm-sync/roClient.ts)
// and every real seller DealFlow holds, plans tomorrow's copy with the copy's own code
// (mapLead, planSync), and works out in memory what each existing seller would end up with
// under the CRM-wins rule and under today's keep-old rule (lib/crm-sync/crmWins.ts). It
// prints counts only: per field, how many sellers would change and how many blanks would be
// filled, plus how many own DealFlow notes would move under the CRM's, how many
// do-not-call statuses would be kept, and how many phone lists would be kept for stored
// per-phone flags. No name, phone number, email, address, note or value is printed. It
// uses the DATABASE_URL and DATABASE_URL_CRM_RO in its environment only (it doesn't load
// .env).
//
// Read only, enforced by the databases (engineering precaution): DealFlow's connection is
// opened with default_transaction_read_only = on, so Postgres refuses any write, and the
// script checks that before its first read; the CRM link runs every statement in a READ
// ONLY transaction. It doesn't use the copy's dry run (that one runs the writes and rolls
// them back). There is no --apply.
import { Pool } from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { maintenanceApply } from '../lib/dbGuard'
import type { ExistingRow } from '../lib/crm-sync/plan'

// Brief 41.2 (engineering precaution): every script calls a guard before anything else.
// This one never writes, so --apply is refused in main().
const APPLY = maintenanceApply(process.env.DATABASE_URL, 'scripts/brief48-crm-wins-preview.ts (DATABASE_URL)')

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
  const { closeCrmPool } = await import('../lib/crm-sync/roClient')
  const { mapLead } = await import('../lib/crm-sync/mapLead')
  const { planSync } = await import('../lib/crm-sync/plan')
  const { CRM_WINS, CURRENT_SQL, TAKEN_SQL, crmOwnName, crmWinsPreview, describeCrmWins } = await import('../lib/crm-sync/crmWins')

  try {
    const org = await db.organization.findUniqueOrThrow({ where: { slug: ORG_SLUG }, select: { id: true } })
    const flag = await db.featureFlag.findUnique({ where: { id: CRM_WINS }, select: { enabled: true } })
    const leads = await readCrmLeads(ORG_SLUG)
    const plan = planSync(leads.map(mapLead), await db.$queryRawUnsafe<ExistingRow[]>(EXISTING_SQL, org.id))
    const current = new Map((await db.$queryRawUnsafe<Array<{ id: string; before: Record<string, unknown>; flagged: boolean }>>(CURRENT_SQL, org.id))
      .map(r => [r.id, { before: r.before, flagged: r.flagged }]))
    const ownNames = new Map(leads.map(l => [l.mojoId, crmOwnName(l)]))
    const taken = new Set((await db.$queryRawUnsafe<Array<{ mojoId: string }>>(TAKEN_SQL, org.id)).map(r => r.mojoId))
    console.log(JSON.stringify({
      crmWinsSwitch: describeCrmWins(flag),
      crmLeads: leads.length,
      ...crmWinsPreview(plan, current, ownNames, taken),
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
