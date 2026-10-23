// Brief 48 (PR 9, item 4.10): which seller details the CRM holds, and how copying them
// (listing status and last asking price, pre-foreclosure status and auction date, vacancy,
// equity, loan balance, interest rate, tags: lib/crm-sync/sellerDetails.ts) would change
// tonight's matching and the call list's top 50. Like Brief 44's
// scripts/valuation-switch-preview.ts.
//
//   SCORING_INCLUDE_TEST_BUYERS=true DATABASE_URL=<DealFlow> DATABASE_URL_CRM_RO=<CRM, read-only> \
//     npx tsx scripts/brief48-crm-details-preview.ts
//
// It lists the CRM's lead custom fields (their labels, types and how many leads have a
// value; never a value) with the DealFlow column each is copied into, and the CRM's phone
// types counted. Then it loads tonight's scoring inputs as the nightly loads them, but never
// priced by DealFlow's own values (lib/crm-sync/detailsPreview.ts: Brief 49 pins the files
// that read those, and both sides are scored the same way, so the difference is the
// details'), works out in memory the detail columns the next copy would write for each CRM
// seller (by the copy's own rules for the CRM_WINS switch's current setting, crmWins.ts),
// scores every seller against buyer demand both ways, builds the call list both ways, and prints counts
// only: per column the leads with a field, values too unclear to copy, sellers filled and
// changed; equity and loan balances under $1,000; sellers by listing status and how many newly count as still on the market;
// tiers, sellers with matches, seller-buyer pairs refused as currently listed, the call
// list's length; Brief 47's size check on the details alone, and the matches the database
// holds now; and of the top 50, how many leave it, the rank correlation, how many have
// a motivation factor known and how many distinct scores it has. Only the detail columns
// are applied (not the copy's other changes), so the difference is this PR's alone. No
// name, phone number, address or value is printed. It uses the DATABASE_URL and
// DATABASE_URL_CRM_RO in its environment only (it doesn't load .env); production counts
// test buyers as demand (the test-data phase), so run it with SCORING_INCLUDE_TEST_BUYERS=true.
//
// Read only, enforced by the databases (engineering precaution): DealFlow's connection is
// opened with default_transaction_read_only = on, checked before the first read; the CRM
// link runs every statement in a READ ONLY transaction. There is no --apply.
import { Pool } from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { maintenanceApply } from '../lib/dbGuard'
import type { ExistingRow } from '../lib/crm-sync/plan'
import type { CrmField } from '../lib/crm-sync/detailsPreview'
import type { Candidate } from '../lib/matching/nightly/select'

// Brief 41.2 (engineering precaution): every script calls a guard before anything else.
// This one never writes, so --apply is refused in main().
const APPLY = maintenanceApply(process.env.DATABASE_URL, 'scripts/brief48-crm-details-preview.ts (DATABASE_URL)')

// A refusal of this script's own: its message names no data, so it is printed.
class Refused extends Error {}

async function preview(db: PrismaClient) {
  const [session] = await db.$queryRawUnsafe<{ transaction_read_only: string }[]>('SHOW transaction_read_only')
  if (session?.transaction_read_only !== 'on') throw new Refused('the connection is not read only; nothing was read')
  // lib/prisma reuses a client already on globalThis, so the nightly and copy code imported
  // below reads through this read-only connection; checked before any of it runs.
  ;(globalThis as unknown as { prisma?: PrismaClient }).prisma = db
  if ((await import('../lib/prisma')).prisma !== db) throw new Refused('the scoring code is not on the read-only connection; nothing was read')
  const { ORG_SLUG, scoreAll } = await import('../lib/matching/nightly/runScoring')
  const { mojoContactToListingData } = await import('../lib/matching/adapters')
  const { precomputeSubstitutionCounts } = await import('../lib/matching/compsCache')
  const { compareTop, rankInMemory, tierCounts } = await import('../lib/matching/ourEstimatesPreview')
  const { contactScopeWhere } = await import('../lib/ranking/queueBuilder')
  const { EXISTING_SQL } = await import('../lib/crm-sync/runSync')
  const { readCrmLeads } = await import('../lib/crm-sync/crmReader')
  const { closeCrmPool, crmQuery } = await import('../lib/crm-sync/roClient')
  const { mapLead } = await import('../lib/crm-sync/mapLead')
  const { planSync } = await import('../lib/crm-sync/plan')
  const { toUpsertRow } = await import('../lib/crm-sync/upsert')
  const { CURRENT_SQL, countFieldChanges, crmOwnName, crmWinsAfter, crmWinsKeepStatus, keepOldAfter, readCrmWinsSwitch, toCrmWinsRow } = await import('../lib/crm-sync/crmWins')
  const { DETAIL_COLUMNS } = await import('../lib/crm-sync/sellerDetails')
  const {
    CRM_FIELDS_SQL, CRM_PHONE_TYPES_SQL, detailCoverage, fieldInventory, guardWithDetails, knownFactors, listingStatusCounts, pastAuctionDates,
    scoringInputsWithoutOurValues, smallMoneyValues, topSummary, withDetails,
  } = await import('../lib/crm-sync/detailsPreview')
  const { EXISTING_MATCH_COUNTS_SQL } = await import('../lib/matching/nightly/sql')

  try {
    const org = await db.organization.findUniqueOrThrow({ where: { slug: ORG_SLUG }, select: { id: true } })
    const crmFields = fieldInventory(await crmQuery<CrmField>(CRM_FIELDS_SQL, [ORG_SLUG]))
    const phoneTypes = await crmQuery<{ type: string; lineType: string | null; n: number }>(CRM_PHONE_TYPES_SQL, [ORG_SLUG])

    // The detail columns the next copy would write, by its own rules.
    const crmWins = await readCrmWinsSwitch(db)
    const leads = await readCrmLeads(ORG_SLUG)
    const plan = planSync(leads.map(mapLead), await db.$queryRawUnsafe<ExistingRow[]>(EXISTING_SQL, org.id))
    const current = new Map((await db.$queryRawUnsafe<Array<{ id: string; before: Record<string, unknown>; flagged: boolean }>>(CURRENT_SQL, org.id)).map(r => [r.id, r]))
    const names = new Map(leads.map(l => [l.mojoId, crmOwnName(l)]))
    const after = new Map<string, Record<string, unknown>>()
    const pairs: Array<{ mojoId: string; before: Record<string, unknown>; after: Record<string, unknown> }> = []
    for (const u of plan.upserts) {
      const cur = u.keeper ? current.get(u.keeper.id) : undefined
      if (!cur) continue
      const a = crmWins
        ? crmWinsAfter(cur.before, toCrmWinsRow(u, names.get(u.contact.mojoId) ?? null, crmWinsKeepStatus(cur.before.status, u.contact.status)), cur.flagged)
        : keepOldAfter(cur.before, toUpsertRow(u))
      after.set(cur.id, a)
      const only = (s: Record<string, unknown>) => Object.fromEntries(DETAIL_COLUMNS.map(c => [c, s[c] ?? null]))
      pairs.push({ mojoId: u.contact.mojoId, before: only(cur.before), after: only(a) })
    }
    const fieldCounts = countFieldChanges(pairs)
    const coverage = detailCoverage(leads)

    // Tonight's scoring both ways, without our values: as the sellers are, and with the detail columns.
    const inputs = await scoringInputsWithoutOurValues(db, org.id)
    const sellersWith = inputs.sellers.map(s => (after.has(s.id) ? withDetails(s, after.get(s.id)!) : s))
    const listingsWith = sellersWith.map(mojoContactToListingData)
    const ctxWith = {
      ...inputs.ctx,
      substitutionCounts: precomputeSubstitutionCounts(inputs.buyers, listingsWith),
      ryanOwnedListingIds: new Set(sellersWith.filter(s => s.tags.includes('ryan_listing')).map(s => s.id)),
    }
    const today = scoreAll(inputs.listings, inputs.buyers, inputs.ctx, inputs.dismissed)
    const withD = scoreAll(listingsWith, inputs.buyers, ctxWith, inputs.dismissed)
    const ourValuesSwitch = await db.featureFlag.findUnique({ where: { id: 'USE_OUR_ESTIMATES' }, select: { enabled: true } })

    // The call list both ways. No names are read; phone numbers only as present or absent.
    const rows = await db.mojoContact.findMany({
      where: contactScopeWhere(org.id, 'crm'),
      select: {
        id: true, phone: true, additionalPhones: true, phoneDncFlags: true, phoneTypes: true, lastCalled: true, lastDialDate: true,
        status: true, preForeclosureStatus: true, isVacant: true, tags: true, groups: true,
        foreclosureAuctionDate: true, equityBalance: true, totalLoanBalance: true, loanInterestRate: true,
      },
    })
    const contacts = rows.map(c => ({ ...c, phone: c.phone == null ? null : 'number', additionalPhones: c.additionalPhones.map(() => 'number'), tags: c.tags ?? [] }))
    const contactsWith = contacts.map(c => {
      const a = after.get(c.id)
      return a ? { ...c, preForeclosureStatus: a.preForeclosureStatus as string | null, isVacant: a.isVacant as boolean | null, tags: (a.tags as string[] | null) ?? c.tags } : c
    })
    const saved = await db.match.findMany({
      where: { organizationId: org.id, opportunityType: 'contact' },
      select: { opportunityId: true, counterpartId: true, counterpartType: true, createdAt: true },
    })
    const savedAt = new Map(saved.map(m => [`${m.opportunityId}|${m.counterpartId}|${m.counterpartType}`, m.createdAt]))
    const now = new Date()
    const createdAt = (c: Candidate) => savedAt.get(`${c.sellerId}|${c.buyerId}|${c.counterpartType}`) ?? now
    const listToday = rankInMemory(contacts, today.kept, createdAt, now)
    const listWith = rankInMemory(contactsWith, withD.kept, createdAt, now)
    const factorsToday = new Map(rows.map(r => [r.id, knownFactors(r)]))
    const factorsWith = new Map(sellersWith.map(s => [s.id, knownFactors(s)]))

    const side = (n: typeof today, list: typeof listToday, factors: Map<string, number>) => ({
      matches: n.kept.length,
      tiers: tierCounts(n.kept),
      sellersCovered: new Set(n.kept.map(k => k.sellerId)).size,
      // Seller-buyer pairs, not sellers (scoreAll counts every pair it refuses).
      ineligiblePairs: { currentlyListed: n.ineligibleByReason.currently_listed ?? 0, wrongPrice: n.ineligibleByReason.wrong_price ?? 0 },
      callList: list.length,
      top50: topSummary(list, id => factors.get(id) ?? 0),
    })
    const todaySide = side(today, listToday, factorsToday)
    const withSide = side(withD, listWith, factorsWith)
    const [existing] = await db.$queryRawUnsafe<{ matches: number; sellers: number }[]>(EXISTING_MATCH_COUNTS_SQL, org.id)
    const includeTestBuyers = process.env.SCORING_INCLUDE_TEST_BUYERS === 'true'
    if (!includeTestBuyers) console.error('Note: SCORING_INCLUDE_TEST_BUYERS is not "true", so test buyers are left out; production counts them.')
    console.log(JSON.stringify({
      includeTestBuyers,
      crmWinsSwitch: crmWins ? 'on' : 'off',
      // Tonight's matching uses our values when this is true; the preview never does (see above).
      useOurEstimatesTonight: ourValuesSwitch?.enabled === true,
      scoredWithOurValues: false,
      crmFields,
      crmPhoneTypes: phoneTypes,
      details: Object.fromEntries(DETAIL_COLUMNS.map(c => [c, {
        ...coverage[c], sellersFilled: fieldCounts.filled[c] ?? 0, sellersChanged: fieldCounts.changed[c] ?? 0,
      }])),
      sellers: inputs.sellers.length,
      buyers: inputs.buyers.length,
      smallMoneyValues: smallMoneyValues(leads),
      listingStatus: listingStatusCounts(pairs),
      auctionDatesAlreadyPast: pastAuctionDates(pairs, now),
      today: todaySide,
      withDetails: withSide,
      // Brief 47's size check on the details alone (empty: the night goes ahead), and what the
      // database holds now (tonight's real check compares against these, priced as tonight is).
      sizeCheckWithDetails: guardWithDetails({ sellers: inputs.sellers.length, buyers: inputs.buyers.length }, todaySide, withSide),
      matchesInDatabaseNow: existing,
      top50: compareTop(listToday.map(r => r.contactId), listWith.map(r => r.contactId), 50),
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
