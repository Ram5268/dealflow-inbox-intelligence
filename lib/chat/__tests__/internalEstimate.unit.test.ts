import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  makeFakePrisma, contact, match, isoBuyer, ORG_ROW, valuationRun, valuation, noValue, daysAgo, TARGET_LINE, type Row,
} from './pr12Fixtures'

// Brief 43 PR 12 (Q27, T-05, M-05, DRIFT_SCRIPT #12): our estimate in chat, for
// Ryan only. D9 (Brief 42 default D9, restated in Brief 46 §4.2): it may show in
// chat, labeled internal, with its range. Our values stay out of anything sent
// [Ryan, 2026-10-17]: never on the page's cards, never in a draft. Brief 49's age
// rule: a value published more than 100 days ago is no current value. Pure: fake
// Prisma, fictional people.
const fake = makeFakePrisma({ organization: [ORG_ROW], mojoContact: [], valuationRun: [], propertyValuation: [] })
;(globalThis as unknown as { prisma: unknown }).prisma = fake.prisma

function world(over: { runs?: Row[]; values?: Row[]; seller?: Row } = {}) {
  fake.tables.mojoContact = [
    contact({
      id: 'mc_pat', fullName: 'Pat Example', phone: '7185550142', address: '88 Example Ave',
      priorListingStatus: 'EXPIRED', priorListingPrice: 1_950_000, ...over.seller,
    }),
    contact({ id: 'mc_jordan', fullName: 'Jordan Sample', address: '12 Sample St' }),
  ]
  fake.tables.valuationRun = over.runs ?? [valuationRun()]
  fake.tables.propertyValuation = over.values ?? [valuation('mc_pat'), valuation('mc_jordan', { value: 990_000, low: 820_000, high: 1_160_000 })]
  fake.tables.match = [match({ id: 'm_a', opportunityId: 'mc_pat', counterpartId: 'iso_a', score: 92, tier: 'HOT' })]
  fake.tables.extractedOpportunity = [isoBuyer({ id: 'iso_a' })]
  fake.tables.callQueueEntry = []
  fake.tables.matchDismissal = []
  fake.calls.length = 0
}

const ESTIMATE = { value: 1_830_000, low: 1_520_000, high: 2_140_000, asOf: '2026-10-01', runId: 'run_oct' }
const OUR_FIGURES = /1830000|1520000|2140000|1[.,]83|1[.,]52|2[.,]14/

async function tools() {
  return import('../tools/crmSellerTools')
}
async function findPat() {
  const { runCrmSellerTool, newCrmSellerTurn } = await tools()
  return runCrmSellerTool('find_seller', { name: 'Pat Example' }, newCrmSellerTurn())
}

test('find_seller: the newest published value reaches the tool output with its range, date and run', async () => {
  world()
  const run = await findPat()
  const out = run.output as { match: Record<string, unknown> }
  assert.deepEqual(out.match.internalEstimate, ESTIMATE)
  // Q27: the last asking price and its status come along (a past listing, not our value).
  assert.equal(out.match.priorListingStatus, 'EXPIRED')
  assert.equal(out.match.priorListingPrice, 1_950_000)
  // Only this seller's valuations were read.
  const q = fake.calls.filter(c => c.model === 'propertyValuation')
  assert.equal(q.length, 1)
  assert.equal((q[0].args?.where as Row).contactId, 'mc_pat')
})

test("Drift reads it as one internal line, with the date as 'Oct 1' and no run id", async () => {
  world()
  const run = await findPat()
  const seen = run.forModel as { match: Record<string, unknown> }
  assert.deepEqual(seen.match.internalEstimate, { value: 1_830_000, low: 1_520_000, high: 2_140_000, asOf: 'Oct 1', say: TARGET_LINE })
  assert.equal(seen.match.priorListingPrice, 1_950_000)
  assert.ok(!JSON.stringify(seen).includes('run_oct'))
})

test('the seller card the page shows (and the chat stores) never carries our value', async () => {
  world()
  const { isSellerCard } = await import('../sellerCard')
  const run = await findPat()
  assert.ok(run.card && isSellerCard(run.card))
  for (const k of ['internalEstimate', 'priorListingStatus', 'priorListingPrice']) assert.ok(!(k in run.card!), k)
  assert.ok(!OUR_FIGURES.test(JSON.stringify(run.card)))
  assert.equal(run.card!.name, 'Pat Example')
})

test("get_seller_matches: the seller carries the estimate for Drift; the matches card doesn't", async () => {
  world()
  const { runCrmSellerTool, newCrmSellerTurn } = await tools()
  const run = await runCrmSellerTool('get_seller_matches', { name: 'Pat Example' }, newCrmSellerTurn())
  const out = run.output as { seller: Record<string, unknown>; count: number }
  assert.equal(out.count, 1)
  assert.deepEqual(out.seller.internalEstimate, ESTIMATE)
  assert.equal(out.seller.priorListingStatus, 'EXPIRED')
  assert.equal(out.seller.kind, 'crm_seller')
  const seen = run.forModel as { seller: Record<string, unknown> }
  assert.equal((seen.seller.internalEstimate as Record<string, unknown>).say, TARGET_LINE)
  assert.ok(run.matchesCard)
  for (const k of ['internalEstimate', 'priorListingStatus', 'priorListingPrice']) assert.ok(!(k in run.matchesCard!.seller), k)
  assert.ok(!OUR_FIGURES.test(JSON.stringify(run.matchesCard)))
})

test('newest published run wins; an unpublished run is never read', async () => {
  world({
    runs: [
      valuationRun({ id: 'run_sep', publishedAt: daysAgo(48) }),
      valuationRun(),
      // A newer run that hasn't passed its publish checks.
      valuationRun({ id: 'run_nov', published: false, publishedAt: null, createdAt: daysAgo(1) }),
    ],
    values: [
      valuation('mc_pat', { runId: 'run_sep', value: 1_700_000, low: 1_400_000, high: 2_000_000, createdAt: daysAgo(48) }),
      valuation('mc_pat'),
      valuation('mc_pat', { runId: 'run_nov', value: 1_990_000, low: 1_650_000, high: 2_330_000, createdAt: daysAgo(1) }),
    ],
  })
  const out = (await findPat()).output as { match: { internalEstimate: unknown } }
  assert.deepEqual(out.match.internalEstimate, ESTIMATE)

  world({ runs: [valuationRun({ published: false, publishedAt: null })] })
  const none = (await findPat()) as { output: { match: Record<string, unknown> }; forModel: { match: Record<string, unknown> } }
  assert.equal(none.output.match.internalEstimate, null)
  assert.equal(none.forModel.match.internalEstimate, null)
})

test('a value published more than 100 days ago is no current value (Brief 49)', async () => {
  world({ runs: [valuationRun({ publishedAt: daysAgo(101) })] })
  const stale = (await findPat()).output as { match: Record<string, unknown> }
  assert.equal(stale.match.internalEstimate, null)
  world({ runs: [valuationRun({ publishedAt: daysAgo(99) })] })
  const fresh = (await findPat()).output as { match: Record<string, unknown> }
  assert.deepEqual(fresh.match.internalEstimate, ESTIMATE)

  // The same rule as matching's (lib/matching/ourEstimates.ts MAX_VALUE_AGE_DAYS), at the boundary.
  const { pickInternalEstimate } = await import('../valuation')
  const now = new Date(Date.UTC(2026, 9, 23, 12))
  const row = (publishedAt: Date | null) => ({
    runId: 'run_oct', value: 1_830_000, low: 1_520_000, high: 2_140_000, asOf: new Date(Date.UTC(2026, 9, 1)),
    createdAt: new Date(Date.UTC(2026, 9, 5)), run: { publishedAt },
  })
  assert.deepEqual(pickInternalEstimate([row(new Date(now.getTime() - 100 * 86_400_000))], now), ESTIMATE)
  assert.equal(pickInternalEstimate([row(new Date(now.getTime() - 100 * 86_400_000 - 1))], now), null)
  assert.equal(pickInternalEstimate([row(null)], now), null)
})

test('a home with no value (5+ units, a condo without a unit) or no valuation gives no estimate', async () => {
  for (const reason of ['five_plus_units', 'condo_without_unit', 'not_found']) {
    world({ values: [noValue('mc_pat', reason)] })
    const r = await findPat()
    assert.equal((r.output as { match: Record<string, unknown> }).match.internalEstimate, null, reason)
    assert.equal((r.forModel as { match: Record<string, unknown> }).match.internalEstimate, null, reason)
  }
  world({ values: [] })
  assert.equal(((await findPat()).output as { match: Record<string, unknown> }).match.internalEstimate, null)
  // The newest published valuation has none: an older month's value is never used.
  world({
    runs: [valuationRun({ id: 'run_sep', publishedAt: daysAgo(48) }), valuationRun()],
    values: [valuation('mc_pat', { runId: 'run_sep', createdAt: daysAgo(48) }), noValue('mc_pat', 'five_plus_units')],
  })
  assert.equal(((await findPat()).output as { match: Record<string, unknown> }).match.internalEstimate, null)
})

test("the line: three figures, an en dash, 'as of' month and day with no year", async () => {
  const { internalEstimateLine, estimateMoney, estimateDay, NO_VALUE_LINE } = await import('../valuation')
  assert.equal(internalEstimateLine(ESTIMATE), TARGET_LINE)
  assert.equal(estimateMoney(845_400), '$845K')
  assert.equal(estimateMoney(999_600), '$1M')
  assert.equal(estimateMoney(2_100_000), '$2.1M')
  assert.equal(estimateMoney(1_834_512), '$1.83M')
  assert.equal(estimateDay('2026-10-01'), 'Oct 1')
  assert.equal(estimateDay('2027-01-31'), 'Jan 31')
  assert.equal(NO_VALUE_LINE, "There's no value on file for that home.")
})

test("the sample reply passes the regex guard (and PR 2's never-sent check)", async () => {
  const { scanForStructuralHallucinations } = await import('../guards/regexGuard')
  const { internalEstimateLine, NO_VALUE_LINE } = await import('../valuation')
  const replies = [
    TARGET_LINE,
    internalEstimateLine({ value: 845_000, low: 700_000, high: 990_000, asOf: '2026-12-01', runId: 'r' }),
    internalEstimateLine({ value: 3_250_000, low: 2_700_000, high: 3_800_000, asOf: '2027-01-31', runId: 'r' }),
    `${TARGET_LINE} It was last listed at $1,950,000 and expired.`,
    NO_VALUE_LINE,
  ]
  for (const reply of replies) {
    assert.deepEqual(scanForStructuralHallucinations(reply, { userMessage: "what's that house worth?" }), [], reply)
  }
})

test("PR 3's draft check blocks the estimate in a draft written the same turn", async () => {
  world()
  const run = await findPat()
  const { buildDraftContext, checkDraft } = await import('../guards/draftPrivacy')
  const ctx = buildDraftContext({ toolResults: [{ name: 'find_seller', input: {}, output: run.output }], userMessage: 'draft a note to my buyer about it', history: [] })
  const draft = {
    channel: 'email' as const, audience: 'buyer_side' as const, subject: 'A 3-family in Bed-Stuy',
    body: 'Hi,\n\nA 3-family in Bed-Stuy may come up. Our internal estimate is $1.83M, likely $1.52M–$2.14M.\n\nRyan Martin',
  }
  const r = checkDraft(draft, ctx)
  assert.ok(r.flags.some(f => f.kind === 'homeowner_price'), JSON.stringify(r.flags))
  assert.ok(!OUR_FIGURES.test(JSON.stringify(r.cleaned)), JSON.stringify(r.cleaned))
})

test('a later draft repeating the estimate from an earlier reply is blocked too; other figures are not', async () => {
  const { buildDraftContext, checkDraft } = await import('../guards/draftPrivacy')
  const history = [
    { role: 'user', content: "what's Pat Example's house worth?" },
    { role: 'assistant', content: TARGET_LINE, dealsJson: [] },
  ]
  // No seller in this turn's tools and nothing in Ryan's message about a homeowner's home.
  const ctx = buildDraftContext({ toolResults: [], userMessage: 'draft an email to my buyer Jordan', history })
  const draft = {
    channel: 'email' as const, audience: 'buyer_side' as const, subject: 'Something in Bed-Stuy',
    body: 'Hi Jordan,\n\nA 3-family in Bed-Stuy may come up, likely around $1.83M.\n\nRyan Martin',
  }
  const r = checkDraft(draft, ctx)
  assert.ok(r.flags.some(f => f.kind === 'homeowner_price' && /1\.83/.test(f.match)), JSON.stringify(r.flags))
  assert.ok(!OUR_FIGURES.test(JSON.stringify(r.cleaned)), JSON.stringify(r.cleaned))

  // Review r1: once our estimate is in the chat, a later draft's other figures get the
  // homeowner rule too (it may be about that home), so a budget figure is flagged.
  const budget = { ...draft, body: 'Hi Jordan,\n\nWith your $2.4M budget, a 3-family in Bed-Stuy may suit you.\n\nRyan Martin' }
  assert.ok(checkDraft(budget, ctx).flags.some(f => f.kind === 'homeowner_price'))
})

test('review r1: a later draft carrying our estimate rounded or reworded is blocked too', async () => {
  const { buildDraftContext, checkDraft } = await import('../guards/draftPrivacy')
  const history = [
    { role: 'user', content: "what's Pat Example's house worth?" },
    { role: 'assistant', content: TARGET_LINE, dealsJson: [] },
  ]
  const ctx = buildDraftContext({ toolResults: [], userMessage: 'draft a note to my buyer Jordan about that house', history })
  for (const s of [
    'It is priced around $1.8M.', 'We think it is about 1.8 million.', 'It should trade just under two million.',
    'It is in the $1.5M–$2.1M range.', 'It should go for about 1.8.', 'Expect high 1s.', 'Roughly $1.8MM.', 'Figure about $2M.',
  ]) {
    const draft = { channel: 'email' as const, audience: 'buyer_side' as const, body: `Hi Jordan,\n\nA 3-family in Bed-Stuy may suit you. ${s}\n\nRyan Martin` }
    const r = checkDraft(draft, ctx)
    assert.ok(r.flags.some(f => f.kind === 'homeowner_price'), s)
    assert.ok(!/1\.8|1\.5|2\.1|\$2M|two million|high 1s/i.test(JSON.stringify(r.cleaned)), `${s} -> ${JSON.stringify(r.cleaned)}`)
  }
})

test("review r1: an earlier reply's other 'estimated' figure isn't ours; a listing keeps its price", async () => {
  const { buildDraftContext, checkDraft } = await import('../guards/draftPrivacy')
  const listing = { id: 'SEED_SALE_06', category: 'ACTIVE_SALE_LISTING', address: '12 Sample St', price: 1_400_000 }
  const history = [
    { role: 'user', content: 'what would the payment be on 12 Sample St with 20% down?' },
    { role: 'assistant', content: "The estimated monthly payment on $1,400,000 with 20% down is about $7,600 at today's rate.", dealsJson: [listing] },
  ]
  const ctx = buildDraftContext({ toolResults: [], userMessage: 'draft a note to my buyer Jordan about 12 Sample St', history })
  assert.deepEqual(ctx.ourFigures, [])
  const draft = { channel: 'email' as const, audience: 'buyer_side' as const, body: 'Hi Jordan,\n\n12 Sample St is listed at $1,400,000 and may suit you.\n\nRyan Martin' }
  assert.deepEqual(checkDraft(draft, ctx).flags, [])
})

test('review r1: a failed read of our values gives no estimate, never a failed lookup, and logs the error class only', async () => {
  world()
  const warnings: string[] = []
  const warn = console.warn
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')) }
  fake.failValuationReads(true)
  try {
    const { runCrmSellerTool, newCrmSellerTurn } = await tools()
    const found = await runCrmSellerTool('find_seller', { name: 'Pat Example' }, newCrmSellerTurn())
    const out = found.output as { match: Record<string, unknown> }
    assert.equal(out.match.name, 'Pat Example')
    assert.equal(out.match.internalEstimate, null)
    assert.equal((found.forModel as { match: Record<string, unknown> }).match.internalEstimate, null)
    const buyers = await runCrmSellerTool('get_seller_matches', { name: 'Pat Example' }, newCrmSellerTurn())
    assert.equal((buyers.output as { count: number }).count, 1)
    assert.equal((buyers.output as { seller: Record<string, unknown> }).seller.internalEstimate, null)
  } finally {
    fake.failValuationReads(false)
    console.warn = warn
  }
  assert.ok(warnings.some(w => w.includes('TypeError')), warnings.join('\n'))
  assert.ok(!warnings.some(w => w.includes('10.0.0.1')), 'only the error class is logged')
})

test("review r1: an earlier reply's last asking price is kept out of a later draft too", async () => {
  const { buildDraftContext, checkDraft } = await import('../guards/draftPrivacy')
  const history = [
    { role: 'user', content: "what's Pat Example's house worth?" },
    { role: 'assistant', content: `${TARGET_LINE} It was last listed at $1,950,000 and expired.`, dealsJson: [] },
  ]
  const ctx = buildDraftContext({ toolResults: [], userMessage: 'draft an email to my buyer Jordan', history })
  assert.ok(ctx.ourFigures?.includes(1_950_000), JSON.stringify(ctx.ourFigures))
  const draft = { channel: 'email' as const, audience: 'buyer_side' as const, body: 'Hi Jordan,\n\nA 3-family in Bed-Stuy may suit you. It was listed at $1.95M before.\n\nRyan Martin' }
  const r = checkDraft(draft, ctx)
  assert.ok(r.flags.some(f => f.kind === 'homeowner_price'))
  assert.ok(!/1\.95|1,950/.test(JSON.stringify(r.cleaned)), JSON.stringify(r.cleaned))
})

test("the prompt: Our estimate (D9), labeled internal, with its range and date; none on file; never in anything sent", async () => {
  const { SYSTEM_PROMPT } = await import('../systemPrompt')
  assert.ok(SYSTEM_PROMPT.includes('Our estimate (D9):'))
  assert.ok(SYSTEM_PROMPT.includes("When Ryan asks what a seller's home is worth, give our internal estimate with its range and date, labeled internal: 'Our internal estimate is $X, likely $A–$B, as of Oct 1. That's for you only.' Never put it in a draft, a report or anything sent."))
  assert.ok(SYSTEM_PROMPT.includes("There's no value on file for that home."))
  assert.ok(SYSTEM_PROMPT.includes('internalEstimate'))
  // The heading sits after PR 5's CRM-seller block (CONTRACT.md: each PR under its own heading).
  assert.ok(SYSTEM_PROMPT.indexOf('Our estimate (D9):') > SYSTEM_PROMPT.indexOf('Your CRM sellers (D11):'))
})
