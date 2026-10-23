import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SYSTEM_PROMPT } from '../systemPrompt'

// Brief 43 PR 6: its lines under PR 5's "Your CRM sellers (D11):" heading.
// Buyers for ONE named seller (D11 [Ryan, 2026-10-18], by address D13 [Ryan,
// 2026-10-19]); the true match count (Q26); "which of my sellers have buyers
// waiting?" as a count plus "they're ranked in your CRM Queue", never names
// (D14 [Ryan, 2026-10-19]); do not contact covers the buyers answer too.
// Pure text tests; no network, no database.
const HEADING = 'Your CRM sellers (D11):'

function block(): string {
  const start = SYSTEM_PROMPT.indexOf(HEADING)
  assert.ok(start >= 0, `SYSTEM_PROMPT has a "${HEADING}" block`)
  const end = SYSTEM_PROMPT.indexOf('\n\n', start)
  return SYSTEM_PROMPT.slice(start, end === -1 ? undefined : end)
}

test('the tools line names the three matches tools', () => {
  const first = SYSTEM_PROMPT.split('\n')[0]
  for (const t of ['get_seller_matches', 'count_matches', 'count_sellers_with_buyers']) assert.ok(first.includes(t), t)
})

test('buyers for one named seller: get_seller_matches, counts by tier first, no link, candidates and none', () => {
  const b = block()
  assert.match(b, /For "which buyers match \[a seller or an address\]\?", use get_seller_matches with the name or address Ryan gave\./)
  assert.match(b, /Lead with the count by tier, then the strongest one or two buyers: what they want, HOT or WARM, the score\./)
  assert.match(b, /The card lists every buyer with an Open in Matches link, so never write a link\./)
  assert.match(b, /Candidates and none work as for find_seller\./)
})

test('do not contact covers a seller from get_seller_matches too', () => {
  const b = block()
  assert.match(b, /If a seller from find_seller or get_seller_matches has doNotContact, say first, [^\n]*?: "This homeowner asked not to be contacted\. Don't call or text them\."/)
})

test('match counts come from count_matches, not the 20-row note', () => {
  assert.match(block(), /For how many matches \(HOT, WARM or all\), use count_matches; the NEW MATCHES note shows only the top 20\./)
})

test('D14: one line, a count via count_sellers_with_buyers, in Ryan\'s Queue wording, never names', () => {
  const b = block()
  assert.ok(b.includes(`use count_sellers_with_buyers and answer: "[N] of your sellers have HOT or WARM buyers waiting. They're ranked in your CRM Queue." Never name them.`))
  assert.equal(b.split('\n').filter(l => l.includes('buyers waiting')).length, 1, 'PR 5\'s number-free line is replaced, not doubled')
  assert.ok(!b.includes("If Ryan asks which of his sellers have buyers waiting, they're ranked in your CRM Queue."))
})

test('the block still follows the feel standard and stays short', () => {
  const b = block()
  assert.ok(!b.includes('—'), 'no em-dash')
  assert.ok(!b.includes('!'), 'no exclamation mark')
  assert.ok(!/https?:\/\//.test(b), 'no link')
  assert.ok(b.length < 2600, `block is ${b.length} characters`)
})
