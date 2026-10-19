import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkDraft,
  buildDraftContext,
  enforceDraftPrivacy,
  liftInlineDraft,
  homeownersInContextBlock,
  DRAFT_READY_LINE,
  type Draft,
  type DraftContext,
  type HomeownerRef,
} from '../draftPrivacy'

// Brief 43 PR 3, review r1: paths the first version missed. Pure tests, no
// database, no network. Everyone here is fictional: "Pat Example",
// (718) 555-0142, "88 Example Ave", a 3-family in Bed-Stuy; "12 Sample St" is a
// listing.

const PAT: HomeownerRef = { name: 'Pat Example', phone: '7185550142', address: '88 Example Ave', notes: null }
const ctx = (over: Partial<DraftContext> = {}): DraftContext => ({
  homeowners: [PAT], typedAddresses: [], listingAddresses: [], listingPrices: [], ...over,
})
const NONE: DraftContext = { homeowners: [], typedAddresses: [], listingAddresses: [], listingPrices: [] }
const toBuyer = (body: string, subject?: string): Draft => ({ channel: 'email', audience: 'buyer_side', ...(subject ? { subject } : {}), body })
const kinds = (d: Draft, c: DraftContext = ctx()) => checkDraft(d, c).flags.map(f => f.kind)
const W = (s: string) => `Hi Jordan,\n\nI have a 3-family in Bed-Stuy that may suit your buyer. ${s} Happy to share more.\n\nBest,\nRyan Martin`

test('the clean-up never leaves part of a figure behind ("$9" of "$9,500")', () => {
  for (const s of ['Rents total $9,500 a month.', 'It is asking $2,100,000 for the building.', 'It would trade at $1,250,000 or so.', 'It sold for $900,000 in 2015.']) {
    const r = checkDraft(toBuyer(W(s)), ctx())
    assert.ok(r.flags.some(f => f.kind === 'homeowner_price'), s)
    assert.ok(r.cleaned, s)
    assert.doesNotMatch(r.cleaned.body, /\d,\d|,\d{3}\b|price on request,/, s)
  }
})

test('a house number with a letter is checked (88A)', () => {
  const c = ctx({ homeowners: [{ ...PAT, address: '88A Example Ave' }] })
  assert.ok(kinds(toBuyer(W('It is at 88A Example Ave.')), c).includes('street_address'))
  // 88 is still not 88A, and 188 is not 88.
  assert.ok(!kinds(toBuyer(W('The listing at 188 Example Ave is lovely.')), c).includes('street_address'))
})

test('a phone written with dashes of any kind is the homeowner\'s phone', () => {
  for (const p of ['718–555–0142', '718—555—0142', '718‑555‑0142']) {
    assert.ok(kinds(toBuyer(W(`Call ${p}.`))).includes('homeowner_phone'), p)
  }
})

test('the name with a middle initial or as a family name is flagged', () => {
  for (const s of ['The owner is Pat Q. Example.', 'The owner is Pat Quinn Example.', "It is Example's home.", 'The Example family owns it.', 'The Examples may sell.']) {
    assert.ok(kinds(toBuyer(W(s))).includes('homeowner_name'), s)
  }
  // A short or lower-case word is left alone ("park", "green").
  const park = ctx({ homeowners: [{ ...PAT, name: 'Jamie Park' }] })
  assert.ok(!kinds(toBuyer(W('It is near Park Slope.')), park).includes('homeowner_name'))
  const green = ctx({ homeowners: [{ ...PAT, name: 'Will Green' }] })
  assert.ok(!kinds(toBuyer(W('It is a green building.')), green).includes('homeowner_name'))
})

test("a homeowner's motivation in other words is flagged in a note about their home", () => {
  for (const s of ['The owner needs to sell quickly.', 'The owner must sell before year end.', 'It is priced to sell.', 'The owner is ill.', 'The owner is elderly and moving to assisted living.', 'The family needs cash.']) {
    assert.ok(kinds(toBuyer(W(s))).includes('seller_circumstance'), s)
  }
  // A listing note with no homeowner may still say "priced to sell".
  assert.deepEqual(kinds(toBuyer('Hi Jordan,\n\nThe 3-bed at 12 Sample St is priced to sell.\n\nBest,\nRyan Martin'), NONE), [])
})

test('a draft to the homeowner labelled "other" (or "buyer_side" when Ryan asked for the owner) gets the homeowner rules', () => {
  const owner18 = (audience: Draft['audience']): Draft => ({ channel: 'text', audience, body: 'Hi, this is Ryan Martin. Your house is worth about $1.4M. Want to chat?' })
  assert.ok(kinds(owner18('other'), NONE).includes('homeowner_price'))
  assert.ok(kinds(owner18('buyer_side'), { ...NONE, toHomeownerAsked: true }).includes('homeowner_price'))
  const found: Draft = { channel: 'text', audience: 'other', body: 'Hi, this is Ryan Martin. I found your home in public records. Act now.' }
  assert.ok(kinds(found, NONE).includes('how_we_found') && kinds(found, NONE).includes('pressure'))
  // The label shown stays Drift's.
  assert.equal(checkDraft(owner18('other'), NONE).cleaned?.audience ?? 'other', 'other')
  // A buyer note that says "your next home" is still a buyer note.
  assert.deepEqual(kinds(toBuyer('Hi Jordan,\n\nThe 3-bed at 12 Sample St could be your next home, asking $1,250,000.\n\nBest,\nRyan Martin'), { ...NONE, listingAddresses: ['12 Sample St'], listingPrices: [1_250_000] }), [])
})

test('a listing from an earlier turn keeps its address and price (no false alarm)', () => {
  const history = [
    { role: 'user', content: 'tell me about 12 Sample St' },
    { role: 'assistant', content: '12 Sample St is a 3-bed asking $1.25M.', dealsJson: [{ id: 'opp1', category: 'ACTIVE_SALE_LISTING', address: '12 Sample St', price: 1_250_000 }] },
  ]
  const c = buildDraftContext({ toolResults: [], userMessage: 'draft an email to my buyer Jordan about it', history })
  const d = toBuyer('Hi Jordan,\n\nThe 3-bed at 12 Sample St is asking $1,250,000. Want to see it this week?\n\nBest,\nRyan Martin', 'The 3-bed at 12 Sample St')
  assert.deepEqual(checkDraft(d, c), { flags: [], cleaned: d })
  // A buyer's budget in dealsJson is not a listing price.
  const buyer = buildDraftContext({ toolResults: [], userMessage: 'x', history: [{ role: 'assistant', content: '', dealsJson: [{ category: 'BUYER_ISO', minPrice: 2_000_000, maxPrice: 2_100_000 }] }] })
  assert.deepEqual(buyer.listingPrices, [])
})

test('a CRM seller looked up in an earlier turn (PR 5 card in dealsJson) is still checked', () => {
  const history = [
    { role: 'user', content: 'pull up Pat Example' },
    { role: 'assistant', content: "Here's their contact.", dealsJson: [{ kind: 'crm_seller', id: 's1', name: 'Pat Example', phone: '(718) 555-0142', address: '88 Example Ave', neighborhood: 'Bedford-Stuyvesant' }] },
  ]
  const c = buildDraftContext({ toolResults: [], userMessage: 'now draft a note to my buyer about her house', history })
  const k = kinds(toBuyer(W('Pat Example at (718) 555-0142 owns 88 Example Ave, around $2.1M.')), c)
  for (const want of ['homeowner_name', 'homeowner_phone', 'street_address', 'homeowner_price']) assert.ok(k.includes(want as never), want)
  // "about her house" makes figures about a homeowner's home even with no detail named.
  assert.ok(kinds(toBuyer(W('It would be around $2.1M.')), c).includes('homeowner_price'))
})

test("the CRM context block's sellers are checked, without flagging every figure", () => {
  const block = '\n\nMOJO SELLER LEADS (2 contacts from CRM):\n[MOJO:m1] Pat Example | 88 Example Ave, Brooklyn | Bedford-Stuyvesant | active | list | ph: 7185550142 | notes: roof leaks and wants out before winter\n[MOJO:m2] Jordan Sample | 12 Sample St, Brooklyn | Bushwick |  |  | ph: '
  const refs = homeownersInContextBlock(block)
  assert.equal(refs.length, 2)
  assert.deepEqual(refs[0], { name: 'Pat Example', address: '88 Example Ave', phone: '7185550142', notes: 'roof leaks and wants out before winter' })
  const c = buildDraftContext({ toolResults: [], userMessage: 'draft a note to my buyer', history: [], contextBlock: block })
  const k = kinds(toBuyer(W('The owner, Pat Example, lives at 88 Example Ave and is asking $2.1M.')), c)
  for (const want of ['homeowner_name', 'street_address', 'homeowner_price']) assert.ok(k.includes(want as never), want)
  // A listing note in the same turn keeps its own price.
  const listing = toBuyer('Hi Jordan,\n\nA 2-bed in Bushwick at $950,000 may suit your buyer.\n\nBest,\nRyan Martin')
  assert.deepEqual(kinds(listing, c), [])
})

test('an inline draft in the reply is lifted out and checked', async () => {
  const response = "Here's the draft:\n\nHi Jordan,\n\nPat Example at (718) 555-0142 may sell the 3-family at 88 Example Ave in Bed-Stuy, around $2.1M. It is going through probate.\n\nBest,\nRyan"
  const r = await enforceDraftPrivacy({ draft: undefined, response, ctx: ctx() })
  assert.ok(r.outcome === 'cleaned' || r.outcome === 'declined')
  assert.ok(r.flagKinds.includes('homeowner_name') && r.flagKinds.includes('street_address'))
  for (const s of ['Pat', '555', '88 Example', '$', 'probate']) {
    assert.ok(!r.response.includes(s), `reply: ${s}`)
    assert.ok(!JSON.stringify(r.draft).includes(s), `draft: ${s}`)
  }
  // An email with a subject line.
  const lifted = liftInlineDraft("Here you go.\n\nSubject: A 3-family in Bed-Stuy\n\nHi Jordan,\n\nA 3-family in Bed-Stuy. Price on request.\n\nBest,\nRyan Martin\n\nWant a shorter one?")
  assert.deepEqual(lifted, {
    draft: { channel: 'email', audience: 'other', subject: 'A 3-family in Bed-Stuy', body: 'Hi Jordan,\n\nA 3-family in Bed-Stuy. Price on request.\n\nBest,\nRyan Martin' },
    reply: 'Here you go.\n\nWant a shorter one?',
  })
  // A one-line text.
  assert.equal(liftInlineDraft("Hi, this is Ryan Martin. Would you ever consider selling? Thanks, Ryan")?.draft.channel, 'text')
  // Ordinary replies are not drafts.
  for (const plain of ['Hi Ryan, I found three listings in Bed-Stuy.', 'Here are three listings. The first is 12 Sample St.', "Hello. Ryan, I can't send texts; I can draft one."]) {
    assert.equal(liftInlineDraft(plain), null, plain)
  }
  const none = await enforceDraftPrivacy({ draft: undefined, response: 'Here are three listings in Bed-Stuy.', ctx: ctx() })
  assert.deepEqual(none, { draft: null, response: 'Here are three listings in Bed-Stuy.', outcome: 'none', flagKinds: [], rewrote: false })
  // A clean inline draft becomes a draft block; the reply keeps its own words.
  const clean = await enforceDraftPrivacy({ draft: undefined, response: "Hi Jordan,\n\nA 3-family in Bed-Stuy may suit your buyer. Price on request.\n\nBest,\nRyan Martin", ctx: ctx() })
  assert.equal(clean.outcome, 'clean')
  assert.equal(clean.response, DRAFT_READY_LINE)
})

test('a draft sent as a JSON string or as plain text is still checked', async () => {
  const leaky = { channel: 'email', audience: 'buyer_side', body: 'Hi Jordan,\n\nPat Example may sell a 3-family in Bed-Stuy.\n\nBest,\nRyan Martin' }
  for (const raw of [JSON.stringify(leaky), leaky.body]) {
    const r = await enforceDraftPrivacy({ draft: raw, response: DRAFT_READY_LINE, ctx: ctx() })
    assert.ok(r.flagKinds.includes('homeowner_name'), String(raw).slice(0, 20))
    assert.ok(!JSON.stringify(r.draft).includes('Pat'))
  }
  for (const raw of ['none', 'N/A', '', '"none"']) {
    assert.equal((await enforceDraftPrivacy({ draft: raw, response: 'ok', ctx: ctx() })).draft, null, raw)
  }
})

test('the new patterns stay linear on long input', () => {
  const long = `${'Hi Jordan, the Example '.repeat(4000)}\n${'88 '.repeat(4000)}${'$9,'.repeat(4000)}`
  const t0 = Date.now()
  checkDraft(toBuyer(long), ctx())
  liftInlineDraft(`${'Hi '.repeat(20000)}\nRyan`)
  homeownersInContextBlock('[MOJO:x] '.repeat(20000))
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`)
})

// ── Review r1, the executor's additions ──────────────────────────────────────
test('price hints with no "$" figure are flagged in a draft about a homeowner\'s home', () => {
  for (const s of [
    'It would go for about two million.', 'Think two and a half million.', 'It could fetch around a million.',
    'It should trade in the low 2s.', 'Expect the mid-900s.', 'Pricing lands in the high twos.', 'It is a seven-figure home.',
    'It would sell for around 2.1.', 'The owner would take about 2, maybe less.',
  ]) {
    const r = checkDraft(toBuyer(W(s)), ctx())
    assert.ok(r.flags.some(f => f.kind === 'homeowner_price'), s)
    assert.ok(r.cleaned && !r.cleaned.body.includes(s), s)
  }
  // To a homeowner, even with no homeowner on file.
  assert.ok(kinds({ channel: 'text', audience: 'homeowner', body: 'Hi, this is Ryan Martin. Homes like yours sell in the low 2s. Would you consider selling?' }, NONE).includes('homeowner_price'))
})

test('ordinary numbers are not price hints', () => {
  for (const s of [
    'It is around 2 blocks from the A train.', 'It has about 3 bedrooms per unit.', 'Can we meet around 2, before the showing?',
    'A limestone from the mid 80s renovation.', 'Built in the 1920s.', 'About 2pm works for a showing.', 'Thanks a million for the call.',
  ]) {
    assert.ok(!kinds(toBuyer(W(s))).includes('homeowner_price'), s)
  }
  // No homeowner in context: a listing note may say "about two million".
  assert.deepEqual(kinds(toBuyer('Hi Jordan,\n\nThe 3-bed at 12 Sample St is about two million, a good fit.\n\nBest,\nRyan Martin'), NONE), [])
})

test('"#88 on Example Ave" is the homeowner\'s street address', () => {
  assert.ok(kinds(toBuyer(W('It is #88 on Example Ave.'))).includes('street_address'))
  assert.ok(!kinds(toBuyer(W('It is #188 on Example Ave.'))).includes('street_address'))
})

test('a draft loses its **bold**, *italic* and [DEAL:] markup, like the reply does', async () => {
  const r = await enforceDraftPrivacy({
    draft: { channel: 'email', audience: 'buyer_side', subject: '**A 3-family** in Bed-Stuy', body: 'Hi Jordan,\n\nA **3-family** in *Bed-Stuy* [DEAL:SEED_SALE_06] may suit your buyer. Price on request.\n\nBest,\nRyan Martin' },
    response: DRAFT_READY_LINE, ctx: NONE,
  })
  assert.deepEqual(r.draft, { channel: 'email', audience: 'buyer_side', subject: 'A 3-family in Bed-Stuy', body: 'Hi Jordan,\n\nA 3-family in Bed-Stuy may suit your buyer. Price on request.\n\nBest,\nRyan Martin' })
})

test('a reply that addresses Ryan by name is not lifted as a draft', () => {
  for (const plain of [
    'Good morning. Ryan, three listings came in overnight.', 'Good morning. Ryan, I have news on Bed-Stuy.',
    'Hello. Ryan, Three listings fit.', 'Hi there.\n\nRyan, want me to widen the search?',
  ]) {
    assert.equal(liftInlineDraft(plain), null, plain)
  }
  // Real one-line texts still are.
  assert.ok(liftInlineDraft('Hi, this is Ryan Martin. Would you ever consider selling? Thanks, Ryan'))
  assert.ok(liftInlineDraft('Hi Jordan, a 3-family in Bed-Stuy may suit your buyer. Ryan Martin'))
})

// ── Review r2 ────────────────────────────────────────────────────────────────
test('a meeting time or a million idiom in a text to the homeowner is not a price hint', () => {
  const owner = (s: string): Draft => ({ channel: 'text', audience: 'homeowner', body: `Hi, this is Ryan Martin. ${s} Thanks, Ryan Martin` })
  for (const s of [
    'If you ever want to talk about the market, I am free around 5.',
    'Would you have time to talk about selling, maybe around 4?',
    'Homes like yours are one in a million in this market.',
    'It would be a million thanks if you called back.',
  ]) {
    assert.ok(!kinds(owner(s), NONE).includes('homeowner_price'), s)
  }
  // A decimal, or a whole number with no meeting words, still counts.
  for (const s of ['Happy to talk; I think it would sell for around 2.1.', 'The owner would take about 2, maybe less.', 'It could fetch around a million.']) {
    assert.ok(kinds(owner(s), NONE).includes('homeowner_price'), s)
  }
})

test('stripping [DEAL:] tags stays fast on a long run of spaces', () => {
  const t0 = Date.now()
  enforceDraftPrivacy({ draft: { channel: 'text', audience: 'other', body: `Hi,${' '.repeat(40_000)}x [DEAL:SEED_SALE_06]` }, response: 'ok', ctx: NONE })
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`)
})
