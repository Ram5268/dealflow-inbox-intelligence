import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkDraft,
  collectHomeowners,
  buildDraftContext,
  enforceDraftPrivacy,
  fixSignoff,
  DRAFT_FIELD_SCHEMA,
  DRAFT_DECLINED_REPLY,
  DRAFT_READY_LINE,
  type Draft,
  type DraftContext,
  type HomeownerRef,
} from '../draftPrivacy'

// Brief 43 PR 3 (Q3; lead finding (c), spot #17): Drift's drafts never carry
// homeowner details. Pure tests, no database, no network. Everyone here is
// fictional: "Pat Example", (718) 555-0142, "88 Example Ave", a 3-family in
// Bed-Stuy.

const PAT: HomeownerRef = { name: 'Pat Example', phone: '7185550142', address: '88 Example Ave', notes: null }
const ctx = (over: Partial<DraftContext> = {}): DraftContext => ({
  homeowners: [PAT], typedAddresses: [], listingAddresses: [], listingPrices: [], ...over,
})
const toBuyer = (body: string, subject?: string): Draft =>
  ({ channel: 'email', audience: 'buyer_side', ...(subject ? { subject } : {}), body })
const toOwner = (body: string): Draft => ({ channel: 'text', audience: 'homeowner', body })
const kinds = (d: Draft, c: DraftContext = ctx()) => checkDraft(d, c).flags.map(f => f.kind)

const GOOD_HEAD = 'Hi,\n\nI have an off-market 3-family in Bed-Stuy that may suit your buyer. Price on request.\n\nBest,\n'
const GOOD = `${GOOD_HEAD}Ryan Martin`
// Spot #17's failure shape, with the fictional homeowner.
const BAD_17 = 'Hi,\n\nPat Example at (718) 555-0142 may sell the 3-family at 88 Example Ave in Bed-Stuy, within the $2.1M to $3.3M range. It is going through probate.\n\nBest,\nRyan'

// ── §4 PR 3's table ──────────────────────────────────────────────────────────
test("the homeowner's name is flagged", () => {
  assert.ok(kinds(toBuyer(`Hi,\n\nPat Example may sell a 3-family in Bed-Stuy.\n\nRyan Martin`)).includes('homeowner_name'))
  assert.ok(kinds(toBuyer(`Hi,\n\nThe owner, Example, Pat, may sell.\n\nRyan Martin`)).includes('homeowner_name'))
  assert.ok(kinds(toOwner(`Hi Pat, this is Ryan Martin. Would you ever consider selling?`)).includes('homeowner_name'))
  assert.ok(kinds(toBuyer(`Hi,\n\nMs. Example may sell a 3-family in Bed-Stuy.\n\nRyan Martin`)).includes('homeowner_name'))
})

test("the homeowner's 555 phone is flagged in any format", () => {
  for (const p of ['(718) 555-0142', '718-555-0142', '718.555.0142', '7185550142', '+1 718 555 0142', '555-0142']) {
    assert.ok(kinds(toBuyer(`Hi,\n\nCall the owner at ${p} about the 3-family in Bed-Stuy.\n\nRyan Martin`)).includes('homeowner_phone'), p)
  }
  // Another number is not the homeowner's.
  assert.ok(!kinds(toBuyer(`Hi,\n\nThe 3-family in Bed-Stuy is off-market. 718-555-0199\n\nRyan Martin`)).includes('homeowner_phone'))
})

test('"within the $2.1M to $3.3M range" for a homeowner is flagged and cleaned to "price on request"', () => {
  const d = toBuyer('Hi,\n\nI have an off-market 3-family in Bed-Stuy, within the $2.1M to $3.3M investment range.\n\nBest,\nRyan Martin')
  const r = checkDraft(d, ctx())
  assert.ok(r.flags.some(f => f.kind === 'homeowner_price'))
  assert.ok(r.cleaned)
  assert.doesNotMatch(r.cleaned.body, /\$|2\.1|3\.3/)
  assert.match(r.cleaned.body, /3-family in Bed-Stuy, price on request\./)
})

test('"price on request" passes untouched', () => {
  const r = checkDraft(toBuyer(GOOD), ctx())
  assert.deepEqual(r.flags, [])
  assert.deepEqual(r.cleaned, toBuyer(GOOD))
})

test('"probate" and other seller-circumstance words are flagged', () => {
  for (const w of ['It is in probate.', 'The owner is motivated.', 'The heirs are deciding.', 'There is a tax lien.']) {
    const r = checkDraft(toBuyer(`Hi,\n\nI have a 3-family in Bed-Stuy. ${w}\n\nRyan Martin`), ctx())
    assert.ok(r.flags.some(f => f.kind === 'seller_circumstance'), w)
    assert.ok(r.cleaned && !r.cleaned.body.includes(w), w)
  }
  // "real estate" is not "estate".
  assert.deepEqual(kinds(toBuyer('Hi,\n\nA real estate note: a 3-family in Bed-Stuy may suit your buyer.\n\nRyan Martin')), [])
})

test('a "Ryan" sign-off becomes "Ryan Martin" without a rewrite', () => {
  const r = checkDraft(toBuyer(`${GOOD_HEAD}Ryan`), ctx())
  assert.deepEqual(r.flags.map(f => f.kind), ['signoff'])
  assert.equal(r.cleaned?.body, GOOD)
})

test('"Ryan Martin, <any brokerage>" and title sign-offs become "Ryan Martin"', () => {
  for (const sig of [
    'Ryan Martin, Douglas Elliman',
    'Ryan Martin, Example Realty Group',
    'Ryan Martin | Licensed Real Estate Salesperson',
    'Ryan Martin\nLicensed Associate Real Estate Broker\nExample Brokerage',
    '- Ryan',
    'Ryan\nExample Homes NYC',
  ]) {
    const r = checkDraft(toBuyer(GOOD_HEAD + sig), ctx())
    assert.ok(r.cleaned, sig)
    assert.equal(r.cleaned.body, GOOD, sig)
    assert.ok(!r.flags.some(f => f.kind !== 'signoff'), sig)
  }
})

test("the homeowner's street address is flagged, in any spelling", () => {
  for (const a of ['88 Example Ave', '88 Example Avenue', '88 example ave.', '88 EXAMPLE AVE, Brooklyn', '88 Example']) {
    const r = checkDraft(toBuyer(`Hi,\n\nThe 3-family at ${a} in Bed-Stuy may suit your buyer.\n\nRyan Martin`), ctx())
    assert.ok(r.flags.some(f => f.kind === 'street_address'), a)
    assert.ok(r.cleaned === null || !/88 example/i.test(r.cleaned.body), a)
  }
  const subj = checkDraft(toBuyer(GOOD, 'The home at 88 Example Ave'), ctx())
  assert.ok(subj.flags.some(f => f.kind === 'street_address'))
  assert.ok(subj.cleaned && !/88/.test(subj.cleaned.subject ?? ''))
})

test('"a 3-family in Bed-Stuy" passes', () => {
  assert.deepEqual(kinds(toBuyer('Hi,\n\nA 3-family in Bed-Stuy may suit your buyer. Price on request.\n\nRyan Martin')), [])
})

test("a listing's own asking price passes, even with a homeowner in context", () => {
  const c = ctx({ listingAddresses: ['12 Sample St'], listingPrices: [1_250_000] })
  for (const p of ['$1,250,000', '$1.25M', '$1.25 million']) {
    assert.deepEqual(kinds(toBuyer(`Hi,\n\nThe 3-bed at 12 Sample St is asking ${p}.\n\nRyan Martin`), c), [], p)
  }
  // Any other figure is not that listing's price.
  assert.ok(kinds(toBuyer('Hi,\n\nThe 3-family in Bed-Stuy would be around $1.4M.\n\nRyan Martin'), c).includes('homeowner_price'))
})

// ── The executor's extra cases ───────────────────────────────────────────────
test('88 vs 188 Example Ave: the house number must match exactly', () => {
  assert.ok(!kinds(toBuyer('Hi,\n\nThe 3-family at 188 Example Ave may suit your buyer.\n\nRyan Martin')).includes('street_address'))
  const at188 = ctx({ homeowners: [{ ...PAT, address: '188 Example Ave' }] })
  assert.ok(!kinds(toBuyer('Hi,\n\nThe 3-family at 88 Example Ave may suit your buyer.\n\nRyan Martin'), at188).includes('street_address'))
  assert.ok(kinds(toBuyer('Hi,\n\nThe 3-family at 188 Example Ave may suit your buyer.\n\nRyan Martin'), at188).includes('street_address'))
})

test('a homeowner-audience draft with "$1.4M" is cleaned, with or without a homeowner on file', () => {
  for (const c of [ctx(), ctx({ homeowners: [] })]) {
    const r = checkDraft(toOwner('Hi, this is Ryan Martin. Your house is worth about $1.4M in this market. Would you ever consider selling? No pressure at all.'), c)
    assert.ok(r.flags.some(f => f.kind === 'homeowner_price'))
    assert.ok(r.cleaned)
    assert.doesNotMatch(r.cleaned.body, /\$|1\.4|price on request/i)
    assert.match(r.cleaned.body, /consider selling\?/)
  }
})

test('to a homeowner: nothing about how we found them, and no pressure', () => {
  assert.ok(kinds(toOwner('Hi, this is Ryan Martin. I found your home in public records. Would you consider selling?')).includes('how_we_found'))
  assert.ok(kinds(toOwner('Hi, this is Ryan Martin. Act now, buyers are waiting. Would you consider selling?')).includes('pressure'))
})

test('a brokerage name or job title in the body is flagged and taken out', () => {
  const r = checkDraft(toOwner('Hi, this is Ryan Martin with Douglas Elliman. Would you ever consider selling your 3-family? No pressure at all.'), ctx())
  assert.ok(r.flags.some(f => f.kind === 'brokerage_or_title'))
  assert.equal(r.cleaned?.body, 'Hi, this is Ryan Martin. Would you ever consider selling your 3-family? No pressure at all.')
  assert.ok(kinds(toOwner("Hi, I'm a licensed real estate agent. Would you ever consider selling? Ryan Martin")).includes('brokerage_or_title'))
})

test('a draft with no homeowner in context passes untouched', () => {
  const d = toBuyer('Hi,\n\nThe 3-bed at 12 Sample St is asking $1,250,000 and shows well.\n\nBest,\nRyan Martin', 'A 3-bed at 12 Sample St')
  const r = checkDraft(d, { homeowners: [], typedAddresses: [], listingAddresses: [], listingPrices: [] })
  assert.deepEqual(r.flags, [])
  assert.deepEqual(r.cleaned, d)
})

test('an address Ryan typed counts as a homeowner address unless it is a listing found this turn', () => {
  const d = toBuyer('Hi,\n\nThe 3-family at 88 Example Ave may suit your buyer.\n\nRyan Martin')
  assert.ok(kinds(d, ctx({ homeowners: [], typedAddresses: ['88 Example Ave'] })).includes('street_address'))
  assert.deepEqual(kinds(d, ctx({ homeowners: [], typedAddresses: ['88 Example Ave'], listingAddresses: ['88 Example Avenue'] })), [])
  // ...unless it is also a CRM homeowner seen this turn.
  assert.ok(kinds(d, ctx({ typedAddresses: ['88 Example Ave'], listingAddresses: ['88 Example Avenue'] })).includes('street_address'))
})

test("spot #17's draft is cleaned of every homeowner detail", () => {
  const r = checkDraft(toBuyer(BAD_17, 'The home at 88 Example Ave'), ctx())
  for (const k of ['homeowner_name', 'homeowner_phone', 'street_address', 'homeowner_price', 'seller_circumstance', 'signoff']) {
    assert.ok(r.flags.some(f => f.kind === k), k)
  }
  // Nothing useful survives every rule here, so it declines rather than send a husk.
  if (r.cleaned) {
    assert.doesNotMatch(JSON.stringify(r.cleaned), /Pat|555|0142|88 Example|\$|probate/i)
    assert.match(r.cleaned.body, /Ryan Martin$/)
  }
})

test('the clean-up reads naturally: "Hi Pat," becomes "Hi,", a price ending a clause is replaced, a figure mid-clause drops its sentence', () => {
  const owner = checkDraft(toOwner('Hi Pat, this is Ryan Martin with Douglas Elliman. Homes like yours are going for $1.4M to $1.6M right now. Would you ever consider selling? No pressure at all.'), ctx())
  assert.equal(owner.cleaned?.body, 'Hi, this is Ryan Martin. Would you ever consider selling? No pressure at all.')
  const c = ctx({ listingAddresses: ['12 Sample St'], listingPrices: [1_250_000] })
  const two = checkDraft(toBuyer('Hi,\n\nTwo options: the 3-bed at 12 Sample St, asking $1,250,000, and an off-market 3-family in Bed-Stuy around $1.9M.\n\nRyan Martin'), c)
  assert.equal(two.cleaned?.body, 'Hi,\n\nTwo options: the 3-bed at 12 Sample St, asking $1,250,000, and an off-market 3-family in Bed-Stuy, price on request.\n\nRyan Martin')
  const price = checkDraft(toBuyer('Hi,\n\nAn off-market 3-family in Bed-Stuy may suit your buyer. The price is $1.4M.\n\nRyan Martin'), c)
  assert.equal(price.cleaned?.body, 'Hi,\n\nAn off-market 3-family in Bed-Stuy may suit your buyer. Price on request.\n\nRyan Martin')
  const mid = checkDraft(toBuyer("Hi,\n\nAn off-market 3-family in Bed-Stuy may suit your buyer. It fits your buyer's $2M budget well.\n\nRyan Martin"), c)
  assert.equal(mid.cleaned?.body, 'Hi,\n\nAn off-market 3-family in Bed-Stuy may suit your buyer.\n\nRyan Martin')
})

test('a draft that only names the homeowner declines (cleaned is null)', () => {
  assert.equal(checkDraft(toBuyer('Pat Example may sell.\n\nRyan Martin'), ctx()).cleaned, null)
})

test("the homeowner's notes are flagged", () => {
  const c = ctx({ homeowners: [{ ...PAT, notes: 'Wants to move closer to her daughter in the spring' }] })
  assert.ok(kinds(toBuyer('Hi,\n\nThe owner wants to move closer to her daughter in the spring. A 3-family in Bed-Stuy.\n\nRyan Martin'), c).includes('homeowner_notes'))
})

// ── fixSignoff ───────────────────────────────────────────────────────────────
test('fixSignoff: inline text sign-offs, missing sign-offs, and an intro that is not a sign-off', () => {
  assert.equal(fixSignoff('Would you ever consider selling? Thanks, Ryan', 'text').body, 'Would you ever consider selling? Thanks, Ryan Martin')
  assert.equal(fixSignoff('Would you ever consider selling?', 'text').body, 'Would you ever consider selling?\nRyan Martin')
  assert.equal(fixSignoff('Hi, this is Ryan Martin. Would you ever consider selling?', 'text').changed, false)
  assert.equal(fixSignoff('Hi,\n\nA 3-family in Bed-Stuy.\n\nRyan Martin', 'email').changed, false)
})

// ── collectHomeowners ────────────────────────────────────────────────────────
test("collectHomeowners finds PR 5's crm_seller objects and today's MOJO_LEAD party cards", () => {
  const found = collectHomeowners([
    // today: search_parties, as trimCardForGuard leaves a Mojo card
    { name: 'search_parties', input: {}, output: { cards: [
      { id: 'mojo_1', category: 'MOJO_LEAD', title: 'Pat Example — 88 Example Ave', name: 'Pat Example', phone: '7185550142', role: 'seller' },
      { id: 'mojo_2', category: 'MOJO_LEAD', title: 'Jordan Sample — Bedford-Stuyvesant', name: 'Jordan Sample', phone: null, neighborhood: 'Bedford-Stuyvesant' },
      { id: 'iso_1', category: 'BUYER_ISO', title: 'Buyer ISO 3BR Bed-Stuy', name: null, phone: null },
    ], totalMatched: 3 } },
    // PR 5: find_seller → { match: SellerCard }
    { name: 'find_seller', input: { name: 'Lee Fictional' }, output: { match: {
      kind: 'crm_seller', id: 'c1', name: 'Lee Fictional', phone: '(718) 555-0150', address: '12 Sample St',
      neighborhood: 'Bed-Stuy', lastCallResult: null, status: null, doNotContact: false, crmUrl: null } } },
    // PR 6: get_seller_matches → { seller: { kind: 'crm_seller', ... }, buyers }
    { name: 'get_seller_matches', input: {}, output: { seller: { kind: 'crm_seller', id: 'c2', name: 'Sam Placeholder', address: '7 Test Pl', neighborhood: 'Bushwick' }, count: 0, buyers: [] } },
    { name: 'search_listings', input: {}, output: { cards: [{ id: 'l1', category: 'ACTIVE_SALE_LISTING', title: '5 Listing Rd', address: '5 Listing Rd', price: 900000 }] } },
  ])
  assert.deepEqual(found, [
    { name: 'Pat Example', phone: '7185550142', address: '88 Example Ave', notes: null },
    { name: 'Jordan Sample', phone: null, address: null, notes: null },
    { name: 'Lee Fictional', phone: '(718) 555-0150', address: '12 Sample St', notes: null },
    { name: 'Sam Placeholder', phone: null, address: '7 Test Pl', notes: null },
  ])
})

test('buildDraftContext: typed addresses from this message and earlier user turns, listings from search_listings', () => {
  const c = buildDraftContext({
    toolResults: [{ name: 'search_listings', input: {}, output: { cards: [
      { id: 'l1', address: '12 Sample St', price: 1_250_000, priceRange: null },
      { id: 'l2', address: null, price: null, priceRange: [900_000, 1_100_000] },
    ] } }],
    userMessage: 'draft a note to the buyer about the home at 88 Example Ave',
    history: [
      { role: 'user', content: 'what about 7 Test Pl and 12 Sample St?' },
      { role: 'assistant', content: 'Nothing on 99 Assistant Rd.' },
    ],
  })
  assert.deepEqual(c.homeowners, [])
  assert.deepEqual([...c.typedAddresses].sort(), ['12 Sample St', '7 Test Pl', '88 Example Ave'])
  assert.deepEqual(c.listingAddresses, ['12 Sample St'])
  assert.deepEqual(c.listingPrices, [1_250_000, 900_000, 1_100_000])
})

// ── enforceDraftPrivacy (the route's flow, with a fake rewrite) ──────────────
test('a clean draft, or one with only a sign-off fix, needs no rewrite', async () => {
  let calls = 0
  const rewrite = async () => { calls++; return null }
  const clean = await enforceDraftPrivacy({ draft: toBuyer(GOOD), response: "Here's a draft for you to copy.", ctx: ctx(), rewrite })
  assert.equal(clean.outcome, 'clean')
  assert.deepEqual(clean.draft, toBuyer(GOOD))
  const signoff = await enforceDraftPrivacy({ draft: toBuyer(GOOD.replace('Ryan Martin', 'Ryan')), response: 'x', ctx: ctx(), rewrite })
  assert.equal(signoff.outcome, 'signoff_fixed')
  assert.equal(signoff.draft?.body, GOOD)
  assert.equal(calls, 0)
})

test('a flagged draft gets one rewrite with feedback; a clean rewrite is used', async () => {
  const feedback: string[] = []
  const r = await enforceDraftPrivacy({
    draft: toBuyer(BAD_17), response: "Here's a draft for you to copy.", ctx: ctx(),
    rewrite: async (fb) => { feedback.push(fb); return { channel: 'email', audience: 'buyer_side', body: GOOD.replace('Ryan Martin', 'Ryan') } },
  })
  assert.equal(feedback.length, 1)
  assert.match(feedback[0], /Pat Example/)
  assert.match(feedback[0], /88 Example Ave/)
  assert.match(feedback[0], /price on request/)
  assert.match(feedback[0], /Ryan Martin/)
  assert.equal(r.outcome, 'rewritten')
  assert.equal(r.draft?.body, GOOD)
  assert.equal(r.response, "Here's a draft for you to copy.")
  assert.ok(r.flagKinds.includes('homeowner_name'))
})

test('a rewrite that still fails, or throws, falls back to the clean-up', async () => {
  const d = toBuyer('Hi,\n\nI have an off-market 3-family in Bed-Stuy, asking $1.4M. It is in probate.\n\nRyan')
  for (const rewrite of [async () => d, async () => { throw new Error('test: rewrite failed') }]) {
    const r = await enforceDraftPrivacy({ draft: d, response: 'ok', ctx: ctx(), rewrite })
    assert.equal(r.outcome, 'cleaned')
    assert.equal(r.draft?.body, 'Hi,\n\nI have an off-market 3-family in Bed-Stuy, price on request.\n\nRyan Martin')
  }
})

test('a draft that cannot be made safe declines with a short note', async () => {
  const r = await enforceDraftPrivacy({ draft: toBuyer('Pat Example may sell.\n\nRyan'), response: "Here's a draft for you to copy.", ctx: ctx(), rewrite: async () => null })
  assert.equal(r.outcome, 'declined')
  assert.equal(r.draft, null)
  assert.equal(r.response, DRAFT_DECLINED_REPLY)
  assert.doesNotMatch(DRAFT_DECLINED_REPLY, /!|—/)
})

test('a reply that repeats the draft becomes one short line; no draft leaves the reply alone', async () => {
  const r = await enforceDraftPrivacy({ draft: toBuyer(GOOD), response: `Here it is: ${GOOD}`, ctx: ctx(), rewrite: async () => null })
  assert.equal(r.response, DRAFT_READY_LINE)
  const none = await enforceDraftPrivacy({ draft: undefined, response: 'Three listings fit.', ctx: ctx() })
  assert.deepEqual([none.outcome, none.draft, none.response], ['none', null, 'Three listings fit.'])
  const junk = await enforceDraftPrivacy({ draft: { channel: 'email' }, response: 'x', ctx: ctx() })
  assert.equal(junk.outcome, 'none')
})

// ── The field's instructions (drift_response.draft) ──────────────────────────
test("the draft field's description carries the rules, in Ryan's wording for #18", () => {
  const d = DRAFT_FIELD_SCHEMA.description
  for (const s of ['nothing is sent', 'area and type', 'price on request', 'Ryan Martin', "I'll leave the number out; our values stay internal", 'street address', 'low pressure']) {
    assert.ok(d.toLowerCase().includes(s.toLowerCase()), s)
  }
  assert.deepEqual(DRAFT_FIELD_SCHEMA.properties.audience.enum, ['buyer_side', 'homeowner', 'other'])
  assert.deepEqual(DRAFT_FIELD_SCHEMA.properties.channel.enum, ['email', 'text'])
  assert.deepEqual(DRAFT_FIELD_SCHEMA.required, ['channel', 'audience', 'body'])
})

// ── No slow regexes (Node 22 runs CI) ────────────────────────────────────────
test('long runs of spaces, digits and dollar signs check quickly', () => {
  const t0 = Date.now()
  for (const junk of [' '.repeat(20_000), '1'.repeat(20_000), '$1 '.repeat(5_000), 'Ryan '.repeat(4_000), '88 '.repeat(5_000), 'a. '.repeat(5_000)]) {
    checkDraft(toBuyer(`Hi ${junk} there`), ctx())
    checkDraft(toOwner(`${junk}`), ctx())
  }
  assert.ok(Date.now() - t0 < 2_000, `took ${Date.now() - t0} ms`)
})
