// Brief 43 PR 11 (Q16, Q24, Q25; M30): Drift's city-records side lookups
// (deeds, and permits/violations) look up that building in that borough, fire
// on "when did … last sell", and tell Drift when the borough was assumed.
// Runs the real fetchers and query parser on a stand-in for the city datasets
// and the OpenAI parse fallback (lib/__tests__/fakeCityRecords.ts); nothing
// leaves this process. Addresses and names are made up. [engineering precaution]
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { installFakeCityRecords } from '../../../__tests__/fakeCityRecords'
import { acrisFetcher } from '../acris'
import { dobFetcher } from '../dob'
import { parseQuery } from '../../../retrieval/queryParser'
import type { ParsedQuery } from '../../../retrieval/types'

const city = installFakeCityRecords()
beforeEach(() => city.reset())

const plain = (raw: string, over: Partial<ParsedQuery> = {}): ParsedQuery => ({
  raw, neighborhoods: [], boroughs: [], beds: null, minBeds: null, maxBeds: null, minUnits: null, maxUnits: null,
  minPrice: null, maxPrice: null, isRental: null, categories: [], intent: 'general', isCalendar: false,
  isACRIS: false, isDOB: false, isMyBuyer: false, isSellerLead: false, isEmailCampaign: false, broaden: false,
  freshnessOverrideHours: null, usedLLM: false, confidence: 0.5, ...over,
})
const run = (f: typeof acrisFetcher, msg: string, over: Partial<ParsedQuery> = {}) =>
  f({ parsed: plain(msg.toLowerCase(), over), userMessage: msg, queryText: msg.toLowerCase(), isConfirmMessage: false })

test('"when did … last sell" fires the deed lookup with no model help (Q25)', async () => {
  const out = await run(acrisFetcher, 'when did 418 Marigold Street, Brooklyn last sell?')
  assert.ok(city.urlsFor('8h5j-fqxa').length > 0, 'the deed lookup ran')
  assert.match(out.block ?? '', /Last sale: 2019-06-03 for \$1,250,000/)
  city.reset()
  const sellFor = await run(acrisFetcher, 'what did 88 Example Avenue, Brooklyn sell for?')
  assert.ok(city.urlsFor('8h5j-fqxa').length > 0, '"sell for" too')
  // Brief 43 PR 11 review: the lot with the newest deed.
  assert.match(sellFor.block ?? '', /Last sale: 2022-08-01 for \$700,000/)
  city.reset()
  await run(acrisFetcher, 'has 418 Marigold Street, Staten Island sold since 2019?')
  assert.ok(city.urlsFor('8h5j-fqxa').length > 0, '"sold" too')
  // A word that only contains "sell" doesn't count.
  city.reset()
  await run(acrisFetcher, 'draft a note to the seller at 12 Sample Ln, Queens')
  assert.equal(city.urlsFor('8h5j-fqxa').length, 0)
})

test('the parser marks "when did X last sell" as a records question when an address is there', async () => {
  city.ai({ isACRIS: false })   // the model fallback says no; the plain parse decides
  assert.equal((await parseQuery('when did 418 marigold street last sell?')).isACRIS, true)
  assert.equal((await parseQuery('when did 418 marigold st sell')).isACRIS, true)
  // No address: "sell" alone isn't a records question.
  assert.equal((await parseQuery('when did prices in bed-stuy last sell this high?')).isACRIS, false)
})

test('a Queens address with the same number and street as a Brooklyn one gets the Queens building (Q16)', async () => {
  const qn = await run(acrisFetcher, 'who owns 418 Marigold Street, Queens?')
  assert.ok(city.urlsFor('8h5j-fqxa').every(u => /[?&]borough=4(&|$)/.test(u)), city.urlsFor('8h5j-fqxa').join('\n'))
  assert.match(qn.block ?? '', /Current owner: SAM PLACEHOLDER/)
  assert.match(qn.block ?? '', /BBL: Queens Block 04444 Lot 0044/)
  assert.doesNotMatch(qn.block ?? '', /PAT EXAMPLE/)
  assert.doesNotMatch(qn.block ?? '', /assumed/i)

  city.reset()
  const bk = await run(acrisFetcher, 'who owns 418 Marigold St in Bed-Stuy?')
  assert.ok(city.urlsFor('8h5j-fqxa').every(u => /[?&]borough=3(&|$)/.test(u)))
  assert.match(bk.block ?? '', /Current owner: PAT EXAMPLE/)
  assert.doesNotMatch(bk.block ?? '', /SAM PLACEHOLDER/)
})

test('no borough in the message: Brooklyn is assumed, and Drift is told so', async () => {
  const out = await run(acrisFetcher, 'who owns 418 Marigold Street?')
  const block = out.block ?? ''
  assert.match(block, /BBL: Brooklyn Block 01111 Lot 0011/)
  assert.match(block, /Current owner: PAT EXAMPLE/)
  assert.doesNotMatch(block, /SAM PLACEHOLDER/, 'no Queens deed merged in')
  assert.match(block, /Borough assumed: Brooklyn/)
  // The note has no link and no tool or system names.
  const note = block.slice(block.indexOf('Borough assumed'))
  assert.doesNotMatch(note, /https?:|www\.|search_listings|lookup|fetcher|ACRIS|tool/i)

  city.reset()
  await run(acrisFetcher, 'who owns 12 Sample Ln?')
  assert.ok(city.urlsFor('8h5j-fqxa').length > 0)
  assert.ok(city.urlsFor('8h5j-fqxa').every(u => /[?&]borough=3(&|$)/.test(u)), 'searched in Brooklyn only')
})

test('when the message names no borough, the parse fallback\'s borough is used, and said', async () => {
  const out = await run(acrisFetcher, 'who owns 418 Marigold Street?', { boroughs: ['Queens'] })
  assert.match(out.block ?? '', /BBL: Queens Block 04444 Lot 0044/)
  assert.doesNotMatch(out.block ?? '', /Borough assumed/)
  assert.match(out.block ?? '', /Queens/)
})

test('nothing on file in the assumed borough: Drift is told that, and to ask', async () => {
  const out = await run(acrisFetcher, 'who owns 1500 Broadway?')
  const block = out.block ?? ''
  assert.match(block, /No deed records found for this address as written/)
  // Brief 43 PR 11 review: a spelling miss is not proof there are none.
  assert.match(block, /not that none exist/)
  assert.match(block, /Brooklyn/)
  assert.match(block, /Borough assumed: Brooklyn/)
})

test('the records not answering is not "nothing on file"', async () => {
  city.set('8h5j-fqxa', 'fail')
  const out = await run(acrisFetcher, 'who owns 418 Marigold Street, Staten Island?')
  assert.equal(out.block, null)
})

test('permits and violations: that building, in that borough (M30; DRIFT_SCRIPT #22)', async () => {
  const out = await run(dobFetcher, 'any permits or violations at 418 Marigold Street, Queens?')
  assert.match(city.whereFor('ipu4-2q9a')[0], /borough='QUEENS'/)
  assert.match(city.whereFor('ipu4-2q9a')[0], /'MARIGOLD STREET'/)
  assert.match(city.whereFor('3h2n-5cm9')[0], /boro='4'/)
  // Nothing came back from either dataset: "none on file", not silence.
  assert.match(out.block ?? '', /No permits or violations found for this address as written/)
  // Brief 43 PR 11 review: only the older DOB permits and DOB violations are
  // searched, so Drift says what was checked.
  assert.match(out.block ?? '', /DOB NOW/)
  assert.match(out.block ?? '', /not that there are none/)
  assert.doesNotMatch(out.block ?? '', /assumed/i)
})

test('permits with no borough: Brooklyn assumed, and said', async () => {
  city.set('ipu4-2q9a', [{ job_type: 'A2', work_type: 'PL', filing_date: '2024-02-01T00:00:00.000', current_status: 'ISSUED', job_description: 'Replace boiler' }])
  const out = await run(dobFetcher, 'any permits at 418 Marigold St?')
  assert.match(city.whereFor('ipu4-2q9a')[0], /borough='BROOKLYN'/)
  assert.match(out.block ?? '', /PERMIT ACTIVITY/)
  assert.match(out.block ?? '', /BROOKLYN/)
  assert.match(out.block ?? '', /Borough assumed: Brooklyn/)
})

test('the new street forms reach the lookups (Q24)', async () => {
  await run(dobFetcher, 'any permits at 9 Roosevelt Ct, Queens?')
  assert.match(city.whereFor('ipu4-2q9a')[0] ?? '', /'ROOSEVELT COURT'/)
  city.reset()
  await run(acrisFetcher, 'who owns 1500 Broadway, Manhattan?')
  assert.ok(city.urlsFor('8h5j-fqxa').some(u => /street_name=BROADWAY(&|$)/.test(u) && /borough=1(&|$)/.test(u)), city.urlsFor('8h5j-fqxa').join('\n'))
})

test('two boroughs named: Brooklyn is searched, and Drift is told the message named two (review)', async () => {
  const out = await run(acrisFetcher, 'who owns 418 Marigold Street, Brooklyn or Queens?')
  assert.match(out.block ?? '', /named more than one borough/)
  assert.doesNotMatch(out.block ?? '', /didn't name a borough/)
})

test('a borough named elsewhere in the message is used, and Drift is told so (review)', async () => {
  const out = await run(acrisFetcher, 'my Queens buyer asked who owns 418 Marigold Street?')
  assert.match(out.block ?? '', /BBL: Queens Block 04444 Lot 0044/)
  assert.match(out.block ?? '', /Borough taken as Queens from elsewhere in the message/)
  city.reset()
  const typed = await run(acrisFetcher, 'who owns 418 Marigold Street, Queens?')
  assert.doesNotMatch(typed.block ?? '', /BOROUGH NOTE/)
})

test('"any permits or violations there?" uses the previous message\'s address, and says so (review; L4, DRIFT_SCRIPT #22)', async () => {
  const msg = 'any permits or violations there?'
  const out = await dobFetcher({ parsed: plain(msg), userMessage: msg, queryText: msg, isConfirmMessage: false, previousUserMessage: 'who owns 418 Marigold Street, Queens?' })
  assert.match(city.whereFor('ipu4-2q9a')[0] ?? '', /borough='QUEENS'/)
  assert.match(city.whereFor('ipu4-2q9a')[0] ?? '', /'MARIGOLD STREET'/)
  assert.match(out.block ?? '', /the address in Ryan's previous message/)
  // No previous address, or nothing pointing back: no lookup.
  city.reset()
  assert.equal((await dobFetcher({ parsed: plain(msg), userMessage: msg, queryText: msg, isConfirmMessage: false, previousUserMessage: 'show me listings in Bushwick' })).block, null)
  assert.equal((await dobFetcher({ parsed: plain('any permits?'), userMessage: 'any permits?', queryText: 'any permits?', isConfirmMessage: false, previousUserMessage: 'who owns 418 Marigold Street?' })).block, null)
  assert.equal(city.urls.length, 0)
})
