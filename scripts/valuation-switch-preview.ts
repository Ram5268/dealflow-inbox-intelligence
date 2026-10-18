// Brief 44 (PR 4): what turning the USE_OUR_ESTIMATES switch on would change, before the
// executor turns it on (Brief 44 data step V4) or on any day after.
//
//   SCORING_INCLUDE_TEST_BUYERS=true npx tsx scripts/valuation-switch-preview.ts
//
// It loads today's scoring inputs with the nightly job's own code, scores every CRM seller
// against buyer demand twice in memory (without and with our published values, whatever
// the switch is set to), builds the call list both ways, and prints counts only: tiers,
// sellers with matches, how many of the call list's top 50 change and the rank correlation
// of that top 50, and what the nightly rollback check would decide. No name, phone number,
// address or value is printed. It uses the DATABASE_URL in its environment only (it doesn't
// load .env); production counts test buyers as demand (the test-data phase), so run it with
// SCORING_INCLUDE_TEST_BUYERS=true to match tonight's run.
//
// Read only, enforced by the database (engineering precaution): the connection is opened
// with default_transaction_read_only = on, so every statement runs in a READ ONLY
// transaction and Postgres refuses any write; the script checks that before its first
// read. There is no --apply.
import { Pool } from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { maintenanceApply } from '../lib/dbGuard'
import type { Candidate } from '../lib/matching/nightly/select'

// Brief 41.2 (engineering precaution): every script calls a guard before anything else.
// This one never writes, so --apply is refused in main().
const APPLY = maintenanceApply(process.env.DATABASE_URL, 'scripts/valuation-switch-preview.ts (DATABASE_URL)')

// A refusal of this script's own: its message names no data, so it is printed.
class Refused extends Error {}

async function preview(db: PrismaClient) {
  const [session] = await db.$queryRawUnsafe<{ transaction_read_only: string }[]>('SHOW transaction_read_only')
  if (session?.transaction_read_only !== 'on') throw new Refused('the connection is not read only; nothing was read')
  // lib/prisma reuses a client already on globalThis, so the nightly code imported below
  // reads through this read-only connection; checked before any of it runs.
  ;(globalThis as unknown as { prisma?: PrismaClient }).prisma = db
  if ((await import('../lib/prisma')).prisma !== db) throw new Refused('the scoring code is not on the read-only connection; nothing was read')
  const { ORG_SLUG, loadScoringInputs, scoreAll } = await import('../lib/matching/nightly/runScoring')
  const { applyOurEstimates, loadPublishedValues, rollbackCheck } = await import('../lib/matching/ourEstimates')
  const { precomputeSubstitutionCounts } = await import('../lib/matching/compsCache')
  const { contactScopeWhere } = await import('../lib/ranking/queueBuilder')
  const { previewReport, rankInMemory } = await import('../lib/matching/ourEstimatesPreview')

  const org = await db.organization.findUniqueOrThrow({ where: { slug: ORG_SLUG }, select: { id: true } })
  const inputs = await loadScoringInputs(org.id)
  // The switch-off inputs, whichever way the switch is set today, then the same with our values.
  const off = inputs.ourEstimates?.without ?? { listings: inputs.listings, ctx: inputs.ctx }
  const onListings = applyOurEstimates(off.listings, await loadPublishedValues(db, org.id))
  const onCtx = { ...off.ctx, substitutionCounts: precomputeSubstitutionCounts(inputs.buyers, onListings) }
  const without = scoreAll(off.listings, inputs.buyers, off.ctx, inputs.dismissed)
  const withOurs = scoreAll(onListings, inputs.buyers, onCtx, inputs.dismissed)
  const applied = onListings.filter(l => l.ourEstimate === true).length

  // The call list both ways, as tonight's run would rank it. No names are read, and phone
  // numbers are kept only as present or absent (engineering precaution: data minimization).
  const rows = await db.mojoContact.findMany({
    where: contactScopeWhere(org.id, 'crm'),
    select: {
      id: true, phone: true, additionalPhones: true, phoneDncFlags: true, phoneTypes: true, lastCalled: true,
      lastDialDate: true, status: true, preForeclosureStatus: true, isVacant: true, tags: true, groups: true,
    },
  })
  const contacts = rows.map(c => ({ ...c, phone: c.phone == null ? null : 'number', additionalPhones: c.additionalPhones.map(() => 'number') }))
  const saved = await db.match.findMany({
    where: { organizationId: org.id, opportunityType: 'contact' },
    select: { opportunityId: true, counterpartId: true, counterpartType: true, createdAt: true },
  })
  const savedAt = new Map(saved.map(m => [`${m.opportunityId}|${m.counterpartId}|${m.counterpartType}`, m.createdAt]))
  const now = new Date()
  const createdAt = (c: Candidate) => savedAt.get(`${c.sellerId}|${c.buyerId}|${c.counterpartType}`) ?? now // a saved pair keeps its date

  const includeTestBuyers = process.env.SCORING_INCLUDE_TEST_BUYERS === 'true'
  if (!includeTestBuyers) console.error('Note: SCORING_INCLUDE_TEST_BUYERS is not "true", so test buyers are left out; production counts them.')
  console.log(JSON.stringify(previewReport({
    includeTestBuyers,
    switchOn: inputs.ourEstimates !== undefined,
    sellers: off.listings.length,
    buyers: inputs.buyers.length,
    sellersPricedByOurValue: applied,
    without,
    withOurs,
    listWithout: rankInMemory(contacts, without.kept, createdAt, now),
    listWith: rankInMemory(contacts, withOurs.kept, createdAt, now),
    check: rollbackCheck(without.kept, withOurs.kept, applied),
  }), null, 2))
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
