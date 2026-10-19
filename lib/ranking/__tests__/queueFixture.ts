// Brief 45 (PR E): a made-up org for the call-list equivalence test. Each
// contact exercises one branch of buildCallQueue's per-contact logic: every
// hard filter, ties, dismissed pairs on both sides, the 5-match cap, null
// match columns, cooldown, freshness and motivation. Not a *.test.ts file.
import type { Row } from '../../__tests__/memoryDb'

export const ORG = 'org_golden'
export const FIXED_NOW = new Date('2026-10-18T12:00:00.000Z')
const daysAgo = (d: number) => new Date(FIXED_NOW.getTime() - d * 86_400_000)

function contact(id: string, over: Row = {}): Row {
  return {
    id, mojoId: `90${id.slice(1)}`, organizationId: ORG, fullName: `Test Owner ${id}`, isTestData: false,
    metadata: { source: 'crm' }, phone: '7185550101', additionalPhones: [], phoneDncFlags: [false], phoneTypes: ['mobile'],
    lastCalled: null, lastDialDate: null, status: null, preForeclosureStatus: null, isVacant: null,
    neighborhood: 'Crown Heights', tags: [], groups: [], intent: 'SELLER', ...over,
  }
}

let n = 0
function match(opportunityId: string, score: number, over: Row = {}): Row {
  n++
  return {
    id: `m_${String(n).padStart(2, '0')}`, organizationId: ORG, opportunityId, opportunityType: 'contact',
    counterpartId: `buyer_${n}`, counterpartType: 'opportunity', score, matchFitConfidence: 'HIGH',
    captureStatus: 'EXTERNAL_BOTH', createdAt: daysAgo(20), contributions: { neighborhood: 40, beds: 30 }, ...over,
  }
}

export function queueFixture(): Record<string, Row[]> {
  n = 0
  const contacts = [
    contact('c01'),
    contact('c02', { lastCalled: daysAgo(5), phoneTypes: ['landline'] }),
    contact('c03', { status: 'Do Not Call' }),
    contact('c04', { tags: ['DNC'] }),
    contact('c05', { phoneDncFlags: [true] }),
    contact('c06'),
    contact('c07', { additionalPhones: ['7185550102', '7185550103'], phoneDncFlags: [false, true, false], phoneTypes: ['mobile', 'mobile', 'landline'] }),
    contact('c08', { preForeclosureStatus: 'LIS_PENDENS' }),
    contact('c09', { isVacant: true, groups: ['Brownstones'] }),
    contact('c10', { lastDialDate: daysAgo(40) }),
    contact('c11', { phone: null, additionalPhones: ['7185550104'], phoneDncFlags: [false, false], phoneTypes: ['', 'mobile'] }),
    contact('c12', { lastDialDate: daysAgo(1) }),
    contact('c13', { isTestData: true }), // out of the 'crm' scope
    contact('c14', { metadata: { source: 'legacy' } }), // out of the 'crm' scope
  ]
  const matches = [
    match('c01', 92, { captureStatus: 'OWN_BOTH_SIDES', createdAt: daysAgo(2) }),
    match('c02', 70, { matchFitConfidence: 'MEDIUM', createdAt: daysAgo(10) }),
    match('c03', 95),
    match('c04', 90),
    match('c05', 88),
    // c06: no matches at all
    match('c07', 75, { captureStatus: 'OWN_LISTING_ONLY' }), // a tie: insertion order decides the top
    match('c07', 75, { captureStatus: 'OWN_BUYER_ONLY', matchFitConfidence: 'LOW' }),
    match('c08', 85, { contributions: { preForeclosure: 30, neighborhood: 20 } }),
    match('c09', 66, { contributions: { vacancy: 20, beds: 10 } }),
    match('c10', 90, { createdAt: daysAgo(6) }),
    match('c10', 88, { counterpartId: 'buyer_dismissed' }), // dismissed below
    match('c10', 60), match('c10', 58), match('c10', 55), match('c10', 52), match('c10', 51),
    // c11 is the buyer side of two inbox listings; one pair is dismissed.
    match('eo_listing_1', 81, { opportunityType: 'opportunity', counterpartId: 'c11', counterpartType: 'mojo' }),
    match('eo_listing_2', 64, { opportunityType: 'opportunity', counterpartId: 'c11', counterpartType: 'mojo' }),
    match('c12', 77, { captureStatus: null, matchFitConfidence: null, contributions: null }),
    match('c13', 99),
    match('c14', 99),
    match('c01', 99, { organizationId: 'org_other' }), // another org's row
    match('eo_listing_3', 70, { opportunityType: 'opportunity', counterpartType: 'opportunity' }), // inbox × inbox: never ranked
  ]
  return {
    mojoContact: contacts,
    match: matches,
    matchDismissal: [
      { partyId: 'buyer_dismissed', listingId: 'c10' },
      { partyId: 'c11', listingId: 'eo_listing_1' },
    ],
    extractedOpportunity: [
      { id: 'eo_listing_1', category: 'ACTIVE_SALE_LISTING' },
      { id: 'eo_listing_2', category: 'ACTIVE_SALE_LISTING' },
      { id: 'eo_listing_3', category: 'ACTIVE_SALE_LISTING' },
    ],
  }
}
