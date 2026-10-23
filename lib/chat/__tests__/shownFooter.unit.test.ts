import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  pickShownCards, orderShownDeals, footerFromTurn, normalizeShown, shownNoteText, priceText,
  reportBuyerId, reportSummaryLines, SHOWN_NOTE_ECHO, FOOTER_MAX_CARDS, FOOTER_CARD_REPLIES,
} from '../shownFooter'
import { encodeStoredReply, readStoredReply, storedReplyForModel } from '../storedReply'
import { historyForModel, EARLIER_IN_CHAT } from '../history'
import { RYAN_MD } from '../../prompts/ryanMd'

// Brief 43 PR 8 (Q14; X-01, N13): the note of what each reply showed, its
// storage (no migration) and Drift's history. Pure; every listing is fictional.

const ROOT = join(__dirname, '..', '..', '..')
const card = (id: string, address: string | null, price: number | null, matchScore: number, extractedTitle = `Title of ${id}`) =>
  ({ id, address, price, matchScore, extractedTitle, minPrice: null, maxPrice: null })
const A = card('opp_188', '188 Example Ave', 1_600_000, 0.95)
const B = card('opp_88', '88 Example Ave', 1_850_000, 0.9)
const C = card('opp_12', '12 Sample St', 2_400_000, 0.8)

test('the page shows the cards Drift named, in its order; none named: all of them, best match first', () => {
  const seen = ['opp_188', 'opp_88', 'opp_12']
  const named = pickShownCards(seen, ['opp_88', 'opp_12', 'opp_88', 'opp_999', 7])
  assert.deepEqual(named, { ids: ['opp_88', 'opp_12'], inReplyOrder: true })
  assert.deepEqual(orderShownDeals([A, B, C], named).map(d => d.id), ['opp_88', 'opp_12'])
  for (const none of [[], undefined, ['opp_999'], 'opp_88']) {
    const all = pickShownCards(seen, none)
    assert.equal(all.inReplyOrder, false)
    assert.deepEqual(orderShownDeals([C, B, A], all).map(d => d.id), ['opp_188', 'opp_88', 'opp_12'])
  }
})

test('"the second one" is card 2: the page and the note list the same cards in the same order', () => {
  const shown = orderShownDeals([A, B, C], pickShownCards(['opp_188', 'opp_88', 'opp_12'], ['opp_88', 'opp_12']))
  const note = shownNoteText(footerFromTurn({ deals: shown }), { withCards: true })
  assert.equal(note, '[Shown with this reply: 1) 88 Example Ave, $1,850,000 (id opp_88); 2) 12 Sample St, $2,400,000 (id opp_12)]')
  const second = /2\) ([^,]+), [^(]+\(id (\w+)\)/.exec(note)!
  assert.deepEqual([second[1], second[2]], [shown[1].address, shown[1].id])
})

test('the note is compact: at most 10 cards, then a count; the title when there is no address; no brackets', () => {
  const many = Array.from({ length: 13 }, (_, i) => card(`opp_${i}`, i === 0 ? null : `${i} Example Ave`, null, 1, i === 0 ? 'Buyer [ISO]: 2 beds\nin Park Slope' : 'x'))
  const f = footerFromTurn({ deals: many })!
  assert.equal(f.cards!.length, FOOTER_MAX_CARDS)
  assert.equal(f.more, 3)
  assert.deepEqual(f.cards![0], { id: 'opp_0', label: 'Buyer (ISO): 2 beds in Park Slope' })
  assert.match(shownNoteText(f, { withCards: true }), /10\) 9 Example Ave \(id opp_9\); and 3 more\]$/)
  const long = footerFromTurn({ deals: [card('opp_l', 'A'.repeat(300), null, 1)] })!
  assert.ok(long.cards![0].label.length <= 80)
  assert.equal(footerFromTurn({ deals: [] }), null)
  assert.equal(footerFromTurn({}), null)
})

test('prices: one price, a range, or one end of it', () => {
  assert.equal(priceText({ price: 1_850_000 }), '$1,850,000')
  assert.equal(priceText({ minPrice: 1_200_000, maxPrice: 1_500_000 }), '$1,200,000 to $1,500,000')
  assert.equal(priceText({ maxPrice: 1_500_000 }), 'up to $1,500,000')
  assert.equal(priceText({ minPrice: 900_000 }), 'from $900,000')
  assert.equal(priceText({ price: null }), undefined)
})

test('the buyer and report a reply was about, and a report summary of 3 lines', () => {
  const f = footerFromTurn({ buyerId: 'buyer_1', reportId: 'report_1', summary: ['Criteria: Park Slope', 'Matches: 3', 'Near misses: 2', 'a fourth line'] })
  assert.deepEqual(f, { buyerId: 'buyer_1', reportId: 'report_1', summary: ['Criteria: Park Slope', 'Matches: 3', 'Near misses: 2'] })
  assert.equal(shownNoteText(f, { withCards: true }), '[Shown with this reply: Buyer id: buyer_1. Report id: report_1. Report summary:\nCriteria: Park Slope\nMatches: 3\nNear misses: 2]')
  // The buyer of the last report tool call that produced something this turn.
  assert.equal(reportBuyerId([
    { name: 'search_parties', input: {} },
    { name: 'generate_report', input: { params: { buyerId: 'buyer_1' } } },
    { name: 'generate_report_section', input: { params: { buyerId: 'buyer_2' } } },
  ]), 'buyer_2')
  assert.equal(reportBuyerId([{ name: 'search_listings', input: { params: { buyerId: 'x' } } }]), null)
})

test('a report summary: criteria, the match counts, then how many items each list holds (no addresses)', () => {
  const at = '2026-10-19T12:00:00.000Z'
  const lines = reportSummaryLines([
    { key: 'criteria', title: 'Criteria of record', sources: [], content: { metrics: [{ label: 'Summary', value: 'Park Slope · 2 beds' }] } },
    { key: 'matching-inventory', title: 'Matching inventory', sources: [], content: { metrics: [{ label: 'Clear fits (HOT)', value: '1' }, { label: 'Warm', value: '0' }] } },
    { key: 'curated-matches', title: 'Curated matches', sources: [{ type: 'matcher', at }], content: { items: [{ address: '88 Example Ave' }] } },
    { key: 'near-misses', title: 'Near misses', sources: [], content: { items: [] } },
  ])
  assert.deepEqual(lines, ['Criteria: Park Slope · 2 beds', 'Clear fits (HOT): 1, Warm: 0', 'Curated matches: 1, Near misses: 0'])
  assert.deepEqual(reportSummaryLines([]), [])
})

test('stored with the reply (JSON, no migration) and read back; a reply with nothing shown stays plain text', () => {
  const shown = footerFromTurn({ deals: [B, C] })
  const stored = encodeStoredReply({ response: 'Two sales.', shown })
  assert.deepEqual(JSON.parse(stored), { response: 'Two sales.', shown })
  assert.deepEqual(readStoredReply(stored), { response: 'Two sales.', draft: null })
  assert.equal(encodeStoredReply({ response: 'No cards.', shown: null }), 'No cards.')
  assert.equal(storedReplyForModel(stored), 'Two sales.\n\n[Shown with this reply: 1) 88 Example Ave, $1,850,000 (id opp_88); 2) 12 Sample St, $2,400,000 (id opp_12)]')
  // With a draft: the text, the draft, then the note.
  const withDraft = encodeStoredReply({ response: "Here's a draft.", draft: { channel: 'text', audience: 'buyer_side', body: 'Hi. Ryan Martin' }, shown: footerFromTurn({ deals: [B] }) })
  assert.equal(storedReplyForModel(withDraft), "Here's a draft.\n\nDraft (text, buyer_side):\nHi. Ryan Martin\n\n[Shown with this reply: 1) 88 Example Ave, $1,850,000 (id opp_88)]")
})

test('older rows still load: plain text, a draft, a calendar proposal, a malformed note', () => {
  assert.equal(storedReplyForModel('Two coming-soon sales.'), 'Two coming-soon sales.')
  assert.equal(storedReplyForModel(JSON.stringify({ response: 'Shall I add it?', suggestions: [], pendingEvent: { subject: 's', startISO: 'x' } })), 'Shall I add it?')
  assert.equal(storedReplyForModel(JSON.stringify({ response: "Here's a draft.", suggestions: [], draft: { channel: 'email', audience: 'other', body: 'Hello' } })), "Here's a draft.\n\nDraft (email, other):\nHello")
  assert.equal(storedReplyForModel('{not json'), '{not json')
  for (const bad of [null, 7, 'x', [], { cards: 'x' }, { cards: [{ label: 'no id' }] }, { more: 'x' }]) {
    assert.equal(storedReplyForModel(JSON.stringify({ response: 'Hi.', suggestions: [], shown: bad })), 'Hi.', JSON.stringify(bad))
  }
  assert.deepEqual(normalizeShown({ cards: [{ id: 'opp_1', label: '1 Example Ave]', price: '$1' }, { id: 2 }], buyerId: '', more: -1 }), { cards: [{ id: 'opp_1', label: '1 Example Ave)', price: '$1' }] })
})

test('the history builder adds each note; only the newest replies list their cards', () => {
  const noteFor = (i: number) => encodeStoredReply({ response: `reply ${i}`, shown: footerFromTurn({ deals: [card(`opp_${i}`, `${i} Example Ave`, null, 1)], buyerId: `buyer_${i}` }) })
  const rows = Array.from({ length: 7 }, (_, i) => [{ role: 'user', content: `ask ${i}` }, { role: 'assistant', content: noteFor(i) }]).flat()
  const sent = historyForModel(rows)
  assert.equal(sent.length, 14)
  const replies = sent.filter(m => m.role === 'assistant').map(m => m.content)
  // The newest FOOTER_CARD_REPLIES list their cards; the older ones keep the buyer only.
  assert.equal(FOOTER_CARD_REPLIES, 5)
  assert.equal(replies[0], 'reply 0\n\n[Shown with this reply: Buyer id: buyer_0]')
  assert.equal(replies[1], 'reply 1\n\n[Shown with this reply: Buyer id: buyer_1]')
  assert.equal(replies[2], 'reply 2\n\n[Shown with this reply: 1) 2 Example Ave (id opp_2). Buyer id: buyer_2]')
  assert.equal(replies[6], 'reply 6\n\n[Shown with this reply: 1) 6 Example Ave (id opp_6). Buyer id: buyer_6]')
  assert.deepEqual(sent.filter(m => m.role === 'user').map(m => m.content), rows.filter(m => m.role === 'user').map(m => m.content))
})

test('N13: a chat that starts with a "+" report still opens on a placeholder user turn, then the report and its buyer', () => {
  const plus = encodeStoredReply({ response: "Here's the Buyer Match & Search Report for Jordan Sample.", shown: footerFromTurn({ buyerId: 'buyer_1', reportId: 'report_1' }) })
  assert.deepEqual(historyForModel([{ role: 'assistant', content: plus }]), [
    { role: 'user', content: EARLIER_IN_CHAT },
    { role: 'assistant', content: "Here's the Buyer Match & Search Report for Jordan Sample.\n\n[Shown with this reply: Buyer id: buyer_1. Report id: report_1]" },
  ])
  assert.deepEqual(historyForModel([]), [])
})

test("Drift's copy of a note is taken out of its reply (linear on long input)", () => {
  assert.equal('88 Example Ave fits. [Shown with this reply: 1) 88 Example Ave (id opp_88)]'.replace(SHOWN_NOTE_ECHO, ''), '88 Example Ave fits.')
  assert.equal('Two.\n\n[Shown with this reply: Buyer id: b]\nMore.'.replace(SHOWN_NOTE_ECHO, ''), 'Two.\nMore.')
  assert.equal('A [note] stays.'.replace(SHOWN_NOTE_ECHO, ''), 'A [note] stays.')
  // Review r1 (nit): another capitalisation, or a copy cut off before its bracket.
  assert.equal('Two. [shown with this reply: 1) 88 Example Ave (id opp_88)]'.replace(SHOWN_NOTE_ECHO, ''), 'Two.')
  assert.equal('Two.\n\n[Shown with this reply: 1) 88 Example Ave (id opp_88'.replace(SHOWN_NOTE_ECHO, ''), 'Two.')
  const t0 = Date.now()
  ;(' '.repeat(50_000) + '[Shown with this reply' + 'x'.repeat(200_000)).replace(SHOWN_NOTE_ECHO, '')
  assert.ok(Date.now() - t0 < 500)
})

test('RYAN_MD: "that one" comes from the Shown note, not a tool result that is no longer there (Q14)', () => {
  const s3 = RYAN_MD.slice(RYAN_MD.indexOf('## 3. CONTEXT-RESOLUTION'), RYAN_MD.indexOf('## 4.'))
  assert.doesNotMatch(s3, /Look at the LAST tool result in the current conversation/)
  assert.doesNotMatch(s3, /the address is from the LAST tool result/)
  assert.match(s3, /\[Shown with this reply/)
  assert.match(s3, /"The second one" is item 2 of the latest card list/)
  assert.match(s3, /"that buyer" or "same buyer" is the latest buyer id/)
  assert.match(s3, /Never write one/)
  // Review r1 (nit): after a drill-down to one card, an ordinal still counts in the earlier list.
  assert.match(s3, /doesn't replace that list/)
  assert.match(s3, /"Which buyer\?" or "Which listing\?"/)
})

test('drift_response: the cards Ryan sees are the ones Drift names, in its order', () => {
  const route = readFileSync(join(ROOT, 'app/api/chat/route.ts'), 'utf8')
  assert.doesNotMatch(route, /does not gate which cards Ryan sees/)
  assert.match(route, /Ryan sees only these cards, in this order/)
  // Review r1: a card Drift only counts is named too (#4 "Two coming-soon sales; the stronger is ...", then #5).
  assert.match(route, /including ones you only count/)
})
