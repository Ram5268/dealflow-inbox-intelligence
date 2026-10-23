import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeFakePrisma, contact, match, ORG_ROW, type Row } from '../../__tests__/pr6Fixtures'

// Brief 43 PR 6: count_matches (Q26, M-06: "how many HOT matches?" was answered
// from the 20-row NEW MATCHES note) and count_sellers_with_buyers (S-11; D14
// [Ryan, 2026-10-19]: "which of my sellers have buyers waiting?" gets a count,
// plus "they're ranked in your CRM Queue"; never a list, D11 [Ryan, 2026-10-18]).
// Pure: fake Prisma that evaluates every where clause.
const fake = makeFakePrisma({ organization: [ORG_ROW] })
;(globalThis as unknown as { prisma: unknown }).prisma = fake.prisma

// Listing-side matches (an email listing ↔ a buyer request), mixed tiers.
const listing = (over: Row) => match({ opportunityType: 'opportunity', opportunityId: 'eo_listing', ...over })

function counts() {
  fake.tables.match = [
    listing({ id: 'h1', counterpartId: 'iso_1', tier: 'HOT', score: 91 }),
    listing({ id: 'h2', counterpartId: 'iso_2', tier: 'HOT', score: 84, seen: true }),
    match({ id: 'h3', opportunityId: 'mc_s1', counterpartId: 'iso_3', tier: 'HOT', score: 80 }),
    listing({ id: 'h_legacy', counterpartId: 'iso_4', tier: null, score: 85 }), // no stored tier: HOT by score
    listing({ id: 'w1', counterpartId: 'iso_5', tier: 'WARM', score: 70 }),
    match({ id: 'w2', opportunityId: 'mc_s1', counterpartId: 'iso_6', tier: 'WARM', score: 66, seen: true }),
    listing({ id: 'w_legacy', counterpartId: 'iso_7', tier: null, score: 65 }), // WARM by score
    listing({ id: 'p1', counterpartId: 'iso_8', tier: 'POSSIBLE', score: 58 }),
    listing({ id: 'p_legacy', counterpartId: 'iso_9', tier: null, score: 52 }), // POSSIBLE by score
    // Left out of every count:
    listing({ id: 'h_dismissed', counterpartId: 'iso_10', tier: 'HOT', score: 95 }),
    // an older row that put the buyer request on the opportunity side, dismissed too
    match({ id: 'h_dismissed_inverted', opportunityType: 'opportunity', opportunityId: 'iso_11', counterpartId: 'eo_listing', tier: 'HOT', score: 93 }),
    listing({ id: 'showing', counterpartType: 'showing_confirmation', counterpartId: 'eo_listing', tier: null, score: 100 }),
    listing({ id: 'h_other_org', organizationId: 'org_other', counterpartId: 'iso_12', tier: 'HOT', score: 99 }),
  ]
  fake.tables.matchDismissal = [
    { id: 'd1', partyId: 'iso_10', listingId: 'eo_listing' },
    { id: 'd2', partyId: 'iso_11', listingId: 'eo_listing' },
  ]
  fake.calls.length = 0
}

test('count_matches: the real count by tier, stored tier first, legacy rows by the tier thresholds', async () => {
  counts()
  const { countMatches } = await import('../countMatches')
  assert.deepEqual(await countMatches({ tier: 'HOT' }), { tier: 'HOT', count: 4, unseen: 3 })
  assert.deepEqual(await countMatches({ tier: 'WARM' }), { tier: 'WARM', count: 3, unseen: 2 })
  assert.deepEqual(await countMatches({ tier: 'POSSIBLE' }), { tier: 'POSSIBLE', count: 2, unseen: 2 })
  assert.deepEqual(await countMatches({ tier: 'ALL' }), { tier: 'ALL', count: 9, unseen: 7 })
  assert.deepEqual(await countMatches({}), { tier: 'ALL', count: 9, unseen: 7 })
  // The model may write the tier in lower case.
  assert.deepEqual(await countMatches({ tier: 'hot' as never }), { tier: 'HOT', count: 4, unseen: 3 })
})

test('count_matches: a database count, not a capped window', async () => {
  fake.tables.match = Array.from({ length: 1234 }, (_, i) => listing({ id: `bulk_${i}`, counterpartId: `iso_b${i}`, tier: 'HOT', score: 90 }))
  fake.tables.matchDismissal = []
  fake.calls.length = 0
  const { countMatches } = await import('../countMatches')
  assert.deepEqual(await countMatches({ tier: 'HOT' }), { tier: 'HOT', count: 1234, unseen: 1234 })
  assert.ok(!fake.calls.some(c => c.model === 'match' && c.op === 'findMany'), 'no rows read when nothing is dismissed')
})

test('count_sellers_with_buyers: CRM sellers with at least one HOT or WARM match, as a count only', async () => {
  fake.tables.mojoContact = [
    contact({ id: 'mc_a', fullName: 'Probe Seller A' }), // HOT and WARM
    contact({ id: 'mc_b', fullName: 'Probe Seller B' }), // WARM only
    contact({ id: 'mc_c', fullName: 'Probe Seller C' }), // POSSIBLE only
    contact({ id: 'mc_d', fullName: 'Probe Seller D' }), // its only HOT pair was dismissed
    contact({ id: 'mc_e', fullName: 'Probe Seller E' }), // HOT by score, no stored tier
    contact({ id: 'mc_test', fullName: 'Probe Seed Seller', isTestData: true }), // seed data, not a CRM seller
    contact({ id: 'mc_dup', fullName: 'Probe Duplicate', metadata: { source: 'duplicate' } }), // not in the pool
    contact({ id: 'mc_buyer', fullName: 'Probe Buyer', intent: 'BUYER' }),
    contact({ id: 'mc_other', fullName: 'Probe Other Org', organizationId: 'org_other' }),
  ]
  fake.tables.match = [
    match({ id: 'a1', opportunityId: 'mc_a', counterpartId: 'iso_1', tier: 'HOT', score: 90 }),
    match({ id: 'a2', opportunityId: 'mc_a', counterpartId: 'iso_2', tier: 'WARM', score: 70 }),
    match({ id: 'b1', opportunityId: 'mc_b', counterpartId: 'iso_1', tier: 'WARM', score: 66 }),
    match({ id: 'c1', opportunityId: 'mc_c', counterpartId: 'iso_1', tier: 'POSSIBLE', score: 60 }),
    match({ id: 'd1', opportunityId: 'mc_d', counterpartId: 'iso_3', tier: 'HOT', score: 88 }),
    match({ id: 'd2', opportunityId: 'mc_d', counterpartId: 'iso_4', tier: 'POSSIBLE', score: 55 }),
    match({ id: 'e1', opportunityId: 'mc_e', counterpartId: 'iso_5', tier: null, score: 82 }),
    match({ id: 't1', opportunityId: 'mc_test', counterpartId: 'iso_1', tier: 'HOT', score: 99 }),
    match({ id: 'u1', opportunityId: 'mc_dup', counterpartId: 'iso_1', tier: 'HOT', score: 99 }),
    match({ id: 'v1', opportunityId: 'mc_buyer', counterpartId: 'iso_1', tier: 'HOT', score: 99 }),
    match({ id: 'o1', organizationId: 'org_other', opportunityId: 'mc_other', counterpartId: 'iso_1', tier: 'HOT', score: 99 }),
    // An email listing's HOT match is not a CRM seller's.
    listing({ id: 'l1', counterpartId: 'iso_1', tier: 'HOT', score: 99 }),
  ]
  fake.tables.matchDismissal = [{ id: 'dd', partyId: 'iso_3', listingId: 'mc_d' }]
  const { countSellersWithBuyers } = await import('../countMatches')
  const r = await countSellersWithBuyers()
  assert.deepEqual(r, { count: 3, withHot: 2 })
  // Counts only: no name, id or address of any seller (D11).
  assert.deepEqual(Object.keys(r).sort(), ['count', 'withHot'])
  const json = JSON.stringify(r)
  assert.ok(!/Probe|mc_|Example/.test(json))
})

test('count_sellers_with_buyers: only sellers the call Queue ranks, so "they\'re ranked in your CRM Queue" holds', async () => {
  // The Queue's hard filters (lib/ranking/hardFilters.ts) leave out a do-not-call
  // status, an opt-out tag or group, and a seller whose every phone is flagged.
  fake.tables.mojoContact = [
    contact({ id: 'mc_ok', fullName: 'Probe Seller Ok' }),
    contact({ id: 'mc_one_flag', fullName: 'Probe Seller One Flag', phone: '7185550101', additionalPhones: ['7185550102'], phoneDncFlags: [true, false] }),
    contact({ id: 'mc_status', fullName: 'Probe Seller Status', status: 'Do Not Call' }),
    contact({ id: 'mc_tag', fullName: 'Probe Seller Tag', tags: ['DNC'], groups: [] }),
    contact({ id: 'mc_group', fullName: 'Probe Seller Group', tags: [], groups: ['opted_out'] }),
    contact({ id: 'mc_all_flags', fullName: 'Probe Seller All Flags', phone: '7185550103', additionalPhones: [], phoneDncFlags: [true] }),
  ]
  fake.tables.match = fake.tables.mojoContact.map((c, i) => match({ id: `q${i}`, opportunityId: c.id as string, counterpartId: 'iso_1', tier: 'HOT', score: 90 }))
  fake.tables.matchDismissal = []
  const { countSellersWithBuyers } = await import('../countMatches')
  assert.deepEqual(await countSellersWithBuyers(), { count: 2, withHot: 2 })
})

test('count_sellers_with_buyers: not a seller on the CRM\'s own opt-out list, nor one with no phone (the CRM Queue drops both)', async () => {
  fake.tables.mojoContact = [
    contact({ id: 'mc_ok', fullName: 'Probe Seller Ok' }),
    contact({ id: 'mc_crm_optout', fullName: 'Probe Seller Opt Out', metadata: { source: 'crm', crmLeadId: 'lead_oo', crmOptOut: true } }),
    contact({ id: 'mc_no_phone', fullName: 'Probe Seller No Phone', phone: null, additionalPhones: [] }),
    contact({ id: 'mc_second_phone', fullName: 'Probe Seller Second Phone', phone: null, additionalPhones: ['7185550104'] }),
  ]
  fake.tables.match = fake.tables.mojoContact.map((c, i) => match({ id: `o${i}`, opportunityId: c.id as string, counterpartId: 'iso_1', tier: 'HOT', score: 90 }))
  fake.tables.matchDismissal = []
  const { countSellersWithBuyers } = await import('../countMatches')
  assert.deepEqual(await countSellersWithBuyers(), { count: 2, withHot: 2 })
})

test('count_sellers_with_buyers: test mode counts no CRM sellers', async () => {
  process.env.TEST_MODE_ONLY = 'true'
  try {
    const { countSellersWithBuyers } = await import('../countMatches')
    assert.deepEqual(await countSellersWithBuyers(), { count: 0, withHot: 0 })
  } finally {
    delete process.env.TEST_MODE_ONLY
  }
})
