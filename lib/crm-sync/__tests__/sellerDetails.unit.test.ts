import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DETAIL_COLUMNS, DETAIL_FIELDS, dateOf, detailField, listingStatusOf, money, preForeclosureOf, rateOf, sellerDetails, tagsOf, yesNo,
} from '../sellerDetails'
import { mapLead } from '../mapLead'
import { COLUMNS, UPSERT_SQL, diffUpdates } from '../upsert'
import { CRM_WINS_UPDATE_SQL, crmWinsAfter, keepOldAfter, toCrmWinsRow } from '../crmWins'
import { toUpsertRow } from '../upsert'
import type { CrmFieldValue, CrmLeadRow } from '../crmReader'
import type { ExistingRow } from '../plan'

// Brief 48 (PR 9, item 4.10): the copy brings the seller details the CRM stores as custom
// fields (Mojo columns become CustomFieldDefinitions by name when Ryan uploads a file) into
// the columns DealFlow's matching and call list already read: listing status and last
// asking price, pre-foreclosure status and auction date, vacancy, equity, loan balance,
// interest rate, and tags. Pure: no database.
const flat = (s: string) => s.replace(/\s+/g, ' ')
const t = (v: string): CrmFieldValue => ({ t: v, n: null, d: null })
const n = (v: number): CrmFieldValue => ({ t: null, n: v, d: null })
const d = (v: string): CrmFieldValue => ({ t: null, n: null, d: v })

test('each column is read from its accepted field names, in any case or punctuation; nothing else', () => {
  assert.deepEqual([...DETAIL_COLUMNS], ['priorListingStatus', 'priorListingPrice', 'preForeclosureStatus', 'foreclosureAuctionDate',
    'isVacant', 'equityBalance', 'totalLoanBalance', 'loanInterestRate', 'tags'])
  assert.equal(detailField({ 'LISTING_STATUS': t('Expired') }, 'priorListingStatus')?.name, 'LISTING_STATUS')
  assert.equal(detailField({ 'MLS Status': t('Expired'), 'Listing Status': t('Active') }, 'priorListingStatus')?.name, 'Listing Status', 'the first accepted name wins')
  for (const other of ['Status', 'Last Call Result', 'Lead Status', 'Equity %', 'Rate', 'Loan Amount', 'Sale Date']) {
    for (const col of DETAIL_COLUMNS) assert.equal(detailField({ [other]: t('x') }, col), null, `${other} -> ${col}`)
  }
  // A blank value under an accepted name falls through to the next accepted name.
  assert.equal(detailField({ Equity: t('  '), 'Estimated Equity': n(5) }, 'equityBalance')?.name, 'Estimated Equity')
  for (const names of Object.values(DETAIL_FIELDS)) assert.ok(names.length > 0)
})

test('listing status: words DealFlow\'s matching knows, else nothing', () => {
  const cases: Array<[string, string | null]> = [
    ['Expired', 'EXPIRED'], ['expired listing', 'EXPIRED'], ['Withdrawn', 'WITHDRAWN'], ['Cancelled', 'WITHDRAWN'], ['Canceled', 'WITHDRAWN'],
    ['Temporarily Off Market', 'WITHDRAWN'], ['Active', 'ACTIVE'], ['Pending', 'ACTIVE'], ['Under Contract', 'ACTIVE'], ['In Contract', 'ACTIVE'],
    ['Coming Soon', 'ACTIVE'], ['Sold', 'SOLD'], ['Closed', 'SOLD'], ['Never Listed', 'NEVER_LISTED'], ['Off Market', null], ['', null], ['FSBO', null],
  ]
  for (const [raw, want] of cases) assert.equal(listingStatusOf(raw), want, raw)
})

test('pre-foreclosure: the stage when it is named, NONE for a no, a lis pendens for a plain yes (New York forecloses through the courts)', () => {
  const cases: Array<[string, string | null]> = [
    ['Lis Pendens', 'LIS_PENDENS'], ['LP', 'LIS_PENDENS'], ['Notice of Default', 'NOTICE_OF_DEFAULT'], ['NOD', 'NOTICE_OF_DEFAULT'],
    ['Auction Scheduled', 'AUCTION_SCHEDULED'], ['Foreclosure Auction', 'AUCTION_SCHEDULED'], ['No', 'NONE'], ['None', 'NONE'], ['false', 'NONE'],
    ['Yes', 'LIS_PENDENS'], ['Y', 'LIS_PENDENS'], ['REO', null], ['', null],
  ]
  for (const [raw, want] of cases) assert.equal(preForeclosureOf(raw), want, raw)
})

test('yes/no, money, rates, dates and tags are read strictly; anything unclear is left blank', () => {
  for (const v of [t('Yes'), t('Y'), t('true'), t('Vacant'), n(1)]) assert.equal(yesNo(v), true)
  for (const v of [t('No'), t('n'), t('FALSE'), t('Occupied'), t('Not Vacant'), n(0)]) assert.equal(yesNo(v), false)
  for (const v of [t('maybe'), t(''), n(2)]) assert.equal(yesNo(v), null)
  assert.equal(money(t('$1,250,000')), 1_250_000)
  assert.equal(money(n(900_000)), 900_000)
  assert.equal(money(t('-15,000')), -15_000)
  for (const v of [t('12%'), t('about 1M'), t(''), n(Number.NaN)]) assert.equal(money(v), null)
  assert.equal(rateOf(t('3.75%')), 3.75)
  assert.equal(rateOf(n(6.5)), 6.5)
  for (const v of [n(0.0375), n(30), t('n/a')]) assert.equal(rateOf(v), null)
  assert.equal(dateOf(d('2026-12-01 00:00:00')), '2026-12-01 00:00:00')
  assert.equal(dateOf(t('12/01/2026')), '2026-12-01 00:00:00')
  assert.equal(dateOf(t('2026-12-01')), '2026-12-01 00:00:00')
  for (const v of [t('02/30/2026'), t('soon'), t('')]) assert.equal(dateOf(v), null)
  assert.deepEqual(tagsOf(t('DNC, Expired;  Absentee| DNC ')), ['DNC', 'Expired', 'Absentee'])
  assert.equal(tagsOf(t(' , ')), null)
})

const lead: CrmLeadRow = {
  id: 'lead_1', mojoId: '90001', name: 'Pat Example', displayName: 'Pat Example', primaryAddressFull: '88 Example Ave, Brooklyn, NY 11221',
  updatedAt: '2026-10-20 09:00:00', contactName: null, phones: [], emails: [], fields: {},
}

test('mapLead copies what the CRM has, and a lead without these fields maps every one to blank (tags too: no empty list)', () => {
  const none = mapLead(lead)
  for (const c of DETAIL_COLUMNS) assert.equal(none[c], null, c)
  const fields = {
    'Listing Status': t('Expired'), 'List Price': t('$1,450,000'), 'Pre-Foreclosure': t('Lis Pendens'), 'Auction Date': d('2026-12-01 00:00:00'),
    Vacant: t('Yes'), Equity: n(600_000), 'Mortgage Balance': n(300_000), 'Interest Rate': t('3.25%'), Tags: t('Absentee, Tired Landlord'),
  }
  const full = mapLead({ ...lead, fields })
  assert.deepEqual(DETAIL_COLUMNS.map(c => full[c]), DETAIL_COLUMNS.map(c => sellerDetails(fields)[c]))
  assert.deepEqual(DETAIL_COLUMNS.map(c => full[c]), ['EXPIRED', 1_450_000, 'LIS_PENDENS', '2026-12-01 00:00:00', true, 600_000, 300_000, 3.25, ['Absentee', 'Tired Landlord']])
})

test('the copy writes them into existing columns: scalars by the PR 7 rules, tags only ever added to', () => {
  const modes = new Map(COLUMNS.map(([c, type, mode]) => [c, [type, mode]]))
  for (const c of DETAIL_COLUMNS.filter(c => c !== 'tags')) assert.equal(modes.get(c)?.[1], 'fill', c)
  assert.deepEqual(modes.get('tags'), ['text[]', 'union'])
  const keepOld = flat(UPSERT_SQL)
  assert.ok(keepOld.includes(`"isVacant" = COALESCE(m."isVacant", EXCLUDED."isVacant")`))
  assert.ok(keepOld.includes(`"tags" = CASE WHEN EXCLUDED."tags" IS NULL THEN m."tags" ELSE COALESCE(m."tags", '{}') || ARRAY(SELECT x FROM unnest(EXCLUDED."tags") WITH ORDINALITY AS u(x, i) WHERE NOT (x = ANY(COALESCE(m."tags", '{}'))) ORDER BY i) END`))
  const wins = flat(CRM_WINS_UPDATE_SQL)
  assert.ok(wins.includes(`"equityBalance" = COALESCE(s."equityBalance", m."equityBalance")`))
  assert.ok(wins.includes(`"tags" = CASE WHEN s."tags" IS NULL THEN m."tags" ELSE COALESCE(m."tags", '{}') || ARRAY(SELECT x FROM unnest(s."tags") WITH ORDINALITY AS u(x, i) WHERE NOT (x = ANY(COALESCE(m."tags", '{}'))) ORDER BY i) END`))
})

const keeper: ExistingRow = {
  id: 'mc_1', mojoId: '90001', fullName: 'Pat Example', address: '88 Example Ave', state: 'NY', zipCode: '11221',
  phone: null, additionalPhones: [], email: null, additionalEmails: [], crmLeadId: 'lead_1',
}

test('in memory, both rules: blanks filled; DealFlow\'s value kept (keep-old) or replaced (CRM wins); a do-not-call tag never dropped', () => {
  const contact = mapLead({ ...lead, fields: { Equity: n(650_000), Tags: t('Expired'), Vacant: t('No') } })
  const before = { fullName: 'Pat Example', address: '88 Example Ave', equityBalance: 500_000, tags: ['DNC'], isVacant: null }
  const old = keepOldAfter(before, toUpsertRow({ contact, keeper }))
  assert.deepEqual([old.equityBalance, old.tags, old.isVacant], [500_000, ['DNC', 'Expired'], false])
  const wins = crmWinsAfter(before, toCrmWinsRow({ contact, keeper }, 'Pat Example'), false)
  assert.deepEqual([wins.equityBalance, wins.tags, wins.isVacant], [650_000, ['DNC', 'Expired'], false])
  // Adding to the tag list is no change under the keep-old self-check.
  assert.deepEqual(diffUpdates([{ mojoId: '90001', inserted: false, before: { tags: ['DNC'] }, after: { tags: ['DNC', 'Expired'] } }]).changed, [])
  // No tags from the CRM: DealFlow's stay exactly (null stays null, so an untouched row isn't rewritten).
  const quiet = keepOldAfter({ ...before, tags: null }, toUpsertRow({ contact: mapLead(lead), keeper }))
  assert.equal(quiet.tags, null)
})

test('the preview: field inventory, coverage, a seller with the details applied, motivation factors known, flatness; labels and counts only', async () => {
  const { CRM_FIELDS_SQL, CRM_PHONE_TYPES_SQL, detailCoverage, fieldInventory, knownFactors, topSummary, withDetails } = await import('../detailsPreview')
  const { assertSelectOnly } = await import('../roClient')
  for (const s of [CRM_FIELDS_SQL, CRM_PHONE_TYPES_SQL]) {
    assert.doesNotThrow(() => assertSelectOnly(s))
    assert.doesNotMatch(s, /"valueText"|"valueNumber"|"valueDate"|p\.phone\b/, 'no values, no numbers')
  }
  assert.deepEqual(fieldInventory([{ name: 'Equity', type: 'number', leadsWithValue: 3 }, { name: 'Bedrooms', type: 'number', leadsWithValue: 9 }]).map(f => f.copiedTo), ['equityBalance', null])
  const coverage = detailCoverage([{ fields: { Vacant: t('maybe'), Equity: n(5) } }, { fields: { Vacant: t('Yes') } }, { fields: {} }])
  assert.deepEqual([coverage.isVacant, coverage.equityBalance, coverage.tags], [{ leadsWithField: 2, unrecognized: 1 }, { leadsWithField: 1, unrecognized: 0 }, { leadsWithField: 0, unrecognized: 0 }])
  const seller = { id: 'mc_1', tags: ['ryan_listing'], isVacant: null, equityBalance: null, foreclosureAuctionDate: null } as never
  const applied = withDetails(seller, { isVacant: true, equityBalance: 5, foreclosureAuctionDate: '2026-12-01T00:00:00', tags: null })
  assert.deepEqual([applied.isVacant, applied.equityBalance, applied.foreclosureAuctionDate?.toISOString(), applied.tags], [true, 5, '2026-12-01T00:00:00.000Z', ['ryan_listing']])
  assert.equal(knownFactors(applied), 3)
  assert.deepEqual(topSummary([{ contactId: 'a', priorityScore: 70 }, { contactId: 'b', priorityScore: 70 }, { contactId: 'c', priorityScore: 64 }], id => (id === 'c' ? 2 : 0)), { distinctScores: 2, withAnyMotivationFactor: 1 })
})

test('the preview script only reads: a read-only connection checked before the first read, no --apply, not the copy\'s dry run', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(__dirname, '../../../scripts/brief48-crm-details-preview.ts'), 'utf8')
  assert.ok(src.includes(`options: '-c default_transaction_read_only=on'`))
  assert.ok(src.indexOf('SHOW transaction_read_only') < src.indexOf('crmQuery<CrmField>(CRM_FIELDS_SQL'))
  assert.match(src, /if \(APPLY\) \{\s+console\.error\('This script only reads: it has no --apply\.'\)/)
  assert.doesNotMatch(src, /runCrmLeadSync|runNightlyScoring|buildCallQueue|dryRun/)
})

test('a CRM 0 loan balance is a fact (free and clear), not "unknown": it lands both ways; equity 0 and loan 0 together are blank', () => {
  const contact = mapLead({ ...lead, fields: { 'Mortgage Balance': n(0), Equity: n(600_000) } })
  const before = { fullName: 'Pat Example', totalLoanBalance: 250_000, equityBalance: null }
  const wins = crmWinsAfter(before, toCrmWinsRow({ contact, keeper }, 'Pat Example'), false)
  assert.deepEqual([wins.totalLoanBalance, wins.equityBalance], [0, 600_000])
  assert.deepEqual([keepOldAfter({ ...before, totalLoanBalance: null }, toUpsertRow({ contact, keeper })).totalLoanBalance], [0])
  assert.ok(flat(CRM_WINS_UPDATE_SQL).includes(`"totalLoanBalance" = COALESCE(s."totalLoanBalance", m."totalLoanBalance")`))
  // Review r1 (executor): both 0 is a vendor's "unknown", so both stay blank; one 0 alone is kept.
  const both = mapLead({ ...lead, fields: { 'Mortgage Balance': n(0), Equity: t('$0') } })
  assert.deepEqual([both.totalLoanBalance, both.equityBalance], [null, null])
  assert.deepEqual([mapLead({ ...lead, fields: { Equity: n(0) } }).equityBalance], [0])
})

test('review r1: the preview counts equity and loan balances under $1,000 (labels and counts only)', async () => {
  const { smallMoneyValues } = await import('../detailsPreview')
  assert.deepEqual(smallMoneyValues([
    { fields: { Equity: n(0), 'Mortgage Balance': n(0) } }, { fields: { Equity: n(500) } }, { fields: { 'Loan Balance': t('$250') } },
    { fields: { Equity: n(600_000), 'Mortgage Balance': n(0) } }, { fields: { Equity: n(-5_000) } }, { fields: {} },
  ]), { equityUnder1000: 2, loanBalanceUnder1000: 3, bothZero: 1 })
})

// Brief 48 (PR 9 review r1): words that turn a status around, and "N/A", are unclear, not a
// status; DealFlow's own tag words never come from the CRM [engineering precaution].
test('review r1: a negated or ended status is unclear (blank), and N/A is not a known "no"', () => {
  for (const raw of ['Not Active', 'No longer active', 'Non-Active', 'Was Active', 'Active? No', 'Not expired', 'Never sold']) {
    assert.equal(listingStatusOf(raw), null, raw)
  }
  for (const [raw, want] of [['Not Listed', 'NEVER_LISTED'], ['Never Listed', 'NEVER_LISTED'], ['Active', 'ACTIVE'], ['Expired', 'EXPIRED']] as const) {
    assert.equal(listingStatusOf(raw), want, raw)
  }
  for (const raw of ['N/A', 'n/a', 'No data', 'No auction scheduled', 'No Auction Date', 'Auction cancelled', 'No default', 'Not in default',
    'Lis Pendens released', 'LP Dismissed']) {
    assert.equal(preForeclosureOf(raw), null, raw)
  }
  for (const [raw, want] of [['No', 'NONE'], ['N', 'NONE'], ['none', 'NONE'], ['false', 'NONE'], ['Yes', 'LIS_PENDENS'], ['Lis Pendens', 'LIS_PENDENS'],
    ['Auction Scheduled', 'AUCTION_SCHEDULED'], ['Auction Postponed', 'AUCTION_SCHEDULED'], ['NOD', 'NOTICE_OF_DEFAULT']] as const) {
    assert.equal(preForeclosureOf(raw), want, raw)
  }
})

test('review r1: DealFlow\'s own tag words are never copied from the CRM (ryan_listing would let a street address reach buyer notes)', () => {
  assert.deepEqual(tagsOf(t('Absentee, ryan_listing, RYAN_LISTING, Buyer, renter, ryan_buyer, DNC')), ['Absentee', 'DNC'])
  assert.equal(tagsOf(t('ryan_listing')), null)
})

test('review r1: the preview counts sellers by listing status, applies the size check, and hides labels that look like data', async () => {
  const { fieldInventory, guardWithDetails, listingStatusCounts, looksLikeData, pastAuctionDates } = await import('../detailsPreview')
  const at = (d: string | null) => ({ after: { foreclosureAuctionDate: d } })
  assert.equal(pastAuctionDates([at('2019-01-15T00:00:00'), at('2026-12-01T00:00:00'), at(null)], new Date('2026-10-23T12:00:00Z')), 1)
  const pairs = [
    { before: { priorListingStatus: null }, after: { priorListingStatus: 'ACTIVE' } },
    { before: { priorListingStatus: 'ACTIVE' }, after: { priorListingStatus: 'ACTIVE' } },
    { before: { priorListingStatus: null }, after: { priorListingStatus: 'EXPIRED' } },
    { before: { priorListingStatus: null }, after: { priorListingStatus: null } },
  ]
  assert.deepEqual(listingStatusCounts(pairs), { after: { ACTIVE: 2, EXPIRED: 1, blank: 1 }, newlyActive: 1 })
  // Half the sellers with a match passes; fewer than half is refused (Brief 47).
  assert.deepEqual(guardWithDetails({ sellers: 10, buyers: 5 }, { matches: 40, sellersCovered: 10 }, { matches: 20, sellersCovered: 5 }), [])
  assert.deepEqual(guardWithDetails({ sellers: 10, buyers: 5 }, { matches: 40, sellersCovered: 10 }, { matches: 30, sellersCovered: 4 }), ['sellers_shrank'])
  for (const label of ['pat@example.com', '(718) 555-0142', '88 Example Ave 11221']) assert.equal(looksLikeData(label), true, label)
  for (const label of ['Equity', 'Phone 2', 'Listing Status', 'Property Zip Code']) assert.equal(looksLikeData(label), false, label)
  assert.deepEqual(fieldInventory([{ name: '(718) 555-0142', type: 'text', leadsWithValue: 1 }]).map(f => [f.name, f.copiedTo]), [['(hidden: looks like data)', null]])
})
