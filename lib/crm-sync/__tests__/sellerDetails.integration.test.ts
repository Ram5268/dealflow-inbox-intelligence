// Brief 48 (PR 9, item 4.10): the copy brings the seller details the CRM stores as custom
// fields (listing status and last asking price, pre-foreclosure status and auction date,
// vacancy, equity, loan balance, interest rate, tags) into DealFlow's existing columns, by
// the PR 7 rules (switch off: blanks filled; on: a CRM value replaces, a CRM blank never
// erases), with tags only ever added to. Real Postgres 18 (DealFlow's DATABASE_URL and a CRM
// CRM_TEST_DATABASE_URL, both *_test), the made-up people of crmSyncDb.ts. PR 7's golden
// test shows a CRM with none of these fields still gives exactly main's rows.
// npm run test:integration, or alone:
//   DATABASE_URL=<dealflow *_test> CRM_TEST_DATABASE_URL=<crm *_test> npx --yes tsx --test <this file>
// Skipped without CRM_TEST_DATABASE_URL.
// First, so the guard runs before anything touches a database.
import '../../__tests__/requireTestDb'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { prisma } from '../../prisma'
import { closeCrmPool } from '../roClient'
import { readCrmLeads, readCrmOptOutLeadIds } from '../crmReader'
import { mapLead, markOptOut } from '../mapLead'
import { planSync, type ExistingRow } from '../plan'
import { EXISTING_SQL, ORG_SLUG, runCrmLeadSync } from '../runSync'
import { toUpsertRow } from '../upsert'
import { CURRENT_SQL, crmOwnName, crmWinsAfter, crmWinsKeepStatus, keepOldAfter, toCrmWinsRow } from '../crmWins'
import { CRM_LEADS, DF_ORG, DF_ROWS, P, cleanup, createCrmTables, requireTestUrls, seed, type SeedLead } from './crmSyncDb'

const { crmUrl } = requireTestUrls()
const SKIP = !crmUrl
if (SKIP) console.log('skipped: set CRM_TEST_DATABASE_URL (a CRM *_test database) to run the seller-details DB test')
else process.env.DATABASE_URL_CRM_RO = crmUrl

const df = new pg.Client({ connectionString: process.env.DATABASE_URL })
const crm = new pg.Client({ connectionString: crmUrl })

before(async () => {
  if (SKIP) return
  await df.connect()
  await crm.connect()
  const [{ d }] = (await df.query('SELECT current_database() AS d')).rows
  const [{ c }] = (await crm.query('SELECT current_database() AS c')).rows
  assert.ok(/(_test|_perf)$/.test(d) && /(_test|_perf)$/.test(c) && d !== c, 'two distinct test databases')
  await createCrmTables(crm)
})

after(async () => {
  if (SKIP) return
  await cleanup(df, crm)
  await df.end()
  await crm.end()
  await prisma.$disconnect()
  await closeCrmPool()
})

// The details a Mojo upload left on two leads, as custom fields.
const DETAILS: Record<string, SeedLead['fields']> = {
  edited: {
    'Listing Status': { t: 'Expired' }, 'List Price': { t: '$1,450,000' }, 'Pre-Foreclosure': { t: 'Lis Pendens' },
    'Auction Date': { d: '2026-12-01 00:00:00' }, Vacant: { t: 'Yes' }, Equity: { n: 600_000 }, 'Mortgage Balance': { n: 300_000 },
    'Interest Rate': { t: '3.25%' }, Tags: { t: 'Absentee, Tired Landlord' },
  },
  blanks: { Equity: { n: 650_000 }, Tags: { t: 'Expired' }, Vacant: { t: 'No' }, 'Listing Status': { t: 'Off Market' } },
}
const leads = CRM_LEADS.map(l => (DETAILS[l.key] ? { ...l, fields: { ...l.fields, ...DETAILS[l.key] } } : l))
// DealFlow already holds an equity figure, a do-not-call tag and a listing status for one seller.
const rows = DF_ROWS.map(r => (r.id === `${P}mc_blanks` ? { ...r, equityBalance: 500_000, tags: ['DNC'], priorListingStatus: 'WITHDRAWN' } : r))

const COLS = `"priorListingStatus", "priorListingPrice", "preForeclosureStatus", "foreclosureAuctionDate"::text AS "foreclosureAuctionDate",
  "isVacant", "equityBalance", "totalLoanBalance", "loanInterestRate", tags`
const detailsOf = async (id: string) => (await df.query(`SELECT ${COLS} FROM "MojoContact" WHERE id = $1`, [id])).rows[0]

const json = (v: unknown) => JSON.parse(JSON.stringify(v))
const current = async () => new Map((await df.query(CURRENT_SQL, [DF_ORG])).rows.map(r => [r.id as string, r]))

// Seeds, predicts every existing seller's row with the in-memory rules (the preview's),
// runs the copy, and checks the SQL wrote exactly that.
async function copy(on: boolean) {
  await cleanup(df, crm)
  await seed(df, crm, leads, rows)
  if (on) await df.query(`INSERT INTO "FeatureFlag" (id, enabled, "updatedAt") VALUES ('CRM_WINS', true, now())`)
  const crmLeads = await readCrmLeads(ORG_SLUG)
  const optOuts = await readCrmOptOutLeadIds(ORG_SLUG)
  const plan = planSync(crmLeads.map(mapLead).map(c => markOptOut(c, optOuts)), (await df.query(EXISTING_SQL, [DF_ORG])).rows as ExistingRow[])
  const names = new Map(crmLeads.map(l => [l.mojoId, crmOwnName(l)]))
  const was = await current()
  const result = await runCrmLeadSync()
  const now = await current()
  let compared = 0
  for (const u of plan.upserts) {
    if (!u.keeper) continue
    const cur = was.get(u.keeper.id)!
    const predicted = on
      ? crmWinsAfter(cur.before, toCrmWinsRow(u, names.get(u.contact.mojoId) ?? null, crmWinsKeepStatus(cur.before.status, u.contact.status)), cur.flagged)
      : keepOldAfter(cur.before, toUpsertRow(u))
    assert.deepStrictEqual(json(now.get(u.keeper.id)!.before), json(predicted), u.contact.mojoId)
    compared++
  }
  assert.equal(compared, 8)
  return result
}

test('switch off: the CRM\'s details fill DealFlow\'s blanks; a value DealFlow has stays; tags are added to', { skip: SKIP }, async () => {
  const r = await copy(false)
  assert.deepEqual(await detailsOf(`${P}mc_edited`), {
    priorListingStatus: 'EXPIRED', priorListingPrice: 1_450_000, preForeclosureStatus: 'LIS_PENDENS', foreclosureAuctionDate: '2026-12-01 00:00:00',
    isVacant: true, equityBalance: 600_000, totalLoanBalance: 300_000, loanInterestRate: 3.25, tags: ['Absentee', 'Tired Landlord'],
  })
  const blanks = await detailsOf(`${P}mc_blanks`)
  assert.deepEqual([blanks.equityBalance, blanks.tags, blanks.isVacant, blanks.priorListingStatus], [500_000, ['DNC', 'Expired'], false, 'WITHDRAWN'])
  // Sellers with none of these fields in the CRM are untouched (their tags stay '{}', not rewritten).
  assert.deepEqual(await detailsOf(`${P}mc_dnc`), {
    priorListingStatus: null, priorListingPrice: null, preForeclosureStatus: null, foreclosureAuctionDate: null,
    isVacant: null, equityBalance: null, totalLoanBalance: null, loanInterestRate: null, tags: [],
  })
  assert.equal(r.filled.equityBalance, 1)
  assert.equal(r.filled.tags, 1)
  // The new seller of the base seed has no details: blank, and tags blank (as before PR 9).
  const [fresh] = (await df.query(`SELECT tags, "isVacant" FROM "MojoContact" WHERE "mojoId" = $1`, [`${P}m_new`])).rows
  assert.deepEqual([fresh.tags, fresh.isVacant], [null, null])
  const again = await runCrmLeadSync()
  assert.deepEqual([again.inserted, again.updated], [0, 0])
})

test('switch on: a CRM value replaces DealFlow\'s, a CRM blank never erases, and the do-not-call tag stays', { skip: SKIP }, async () => {
  const r = await copy(true)
  const blanks = await detailsOf(`${P}mc_blanks`)
  // 'Off Market' isn't a status DealFlow's matching knows: blank, so DealFlow's WITHDRAWN stays.
  assert.deepEqual([blanks.equityBalance, blanks.tags, blanks.isVacant, blanks.priorListingStatus], [650_000, ['DNC', 'Expired'], false, 'WITHDRAWN'])
  assert.equal((await detailsOf(`${P}mc_edited`)).loanInterestRate, 3.25)
  assert.equal(r.crmWins, true)
  assert.equal(r.changed?.equityBalance, 1)
  assert.equal(r.changed?.tags, 1)
  const again = await runCrmLeadSync()
  assert.deepEqual([again.inserted, again.updated], [0, 0])
  // The do-not-call tag is still the one seller's.
  const [{ n }] = (await df.query(`SELECT count(*)::int AS n FROM "MojoContact" WHERE "organizationId" = $1 AND 'DNC' = ANY(tags)`, [DF_ORG])).rows
  assert.equal(n, 1)
})
