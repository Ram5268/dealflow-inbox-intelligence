import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SellerMatchesCard } from '../../../lib/chat/sellerMatchesCard'
import type { SellerCard } from '../../../lib/chat/sellerCard'

// Brief 43 PR 6 (N1): the chat page's matches card for ONE seller (D11 [Ryan,
// 2026-10-18]): the seller's name and neighborhood, the count by tier, and each
// buyer's line with HOT or WARM, the score, the fit line and an "Open in
// Matches" link that pins that match on /matches (Brief 38). Rendered to static
// HTML here; the executor checks it in a browser.
const card: SellerMatchesCard = {
  kind: 'seller_matches',
  seller: { kind: 'crm_seller', id: 'mc_pat', name: 'Pat Example', address: '88 Example Ave', neighborhood: 'Bedford-Stuyvesant', doNotContact: false },
  count: 3,
  tiers: { hot: 2, warm: 1, possible: 0 },
  buyers: [
    { matchId: 'm_1', tier: 'HOT', score: 92, wants: '2–3 family · Bedford-Stuyvesant · 3+ BR · $1.35M–$2.6M · cash', fit: 'Right neighborhood, bedroom count', isTestData: true, matchesUrl: '/matches?m=m_1' },
    { matchId: 'm_2', tier: 'HOT', score: 84, wants: 'Co-op · Park Slope · 2 BR · $950K', fit: "Fits the buyer's criteria", isTestData: false, matchesUrl: '/matches?m=m_2' },
    { matchId: 'm_3', tier: 'WARM', score: 70, wants: 'Crown Heights · 2–3 BR · $900K–$1.2M', fit: 'Right neighborhood; weaker on bedrooms', isTestData: true, matchesUrl: '/matches?m=m_3' },
  ],
  matchesUrl: '/matches?m=m_1',
}
const sellerCard: SellerCard = {
  kind: 'crm_seller', id: 'mc_pat', name: 'Pat Example', phone: '(718) 555-0142', address: '88 Example Ave',
  neighborhood: 'Bedford-Stuyvesant', lastCallResult: null, status: null, doNotContact: false, crmUrl: 'https://crm.example.test/leads/lead_pat',
}

test('splitStoredChatCards: deals, contact cards and matches cards each come out on their own', async () => {
  const { splitStoredChatCards } = await import('../sellerMatchesView')
  const deal = { id: 'SEED_SALE_06', category: 'COMING_SOON_SALE' }
  assert.deepEqual(splitStoredChatCards([deal, sellerCard, card]), { deals: [deal], sellerCards: [sellerCard], sellerMatches: [card] })
  assert.deepEqual(splitStoredChatCards(undefined), { deals: [], sellerCards: [], sellerMatches: [] })
})

test('headline and title lines', async () => {
  const { matchesHeadline, matchesTitle, shownNote } = await import('../sellerMatchesView')
  assert.equal(matchesTitle(card), 'Pat Example · Bedford-Stuyvesant')
  assert.equal(matchesHeadline(card), '3 matching buyers · 2 HOT · 1 WARM')
  assert.equal(matchesHeadline({ ...card, count: 1, tiers: { hot: 0, warm: 0, possible: 1 } }), '1 matching buyer · 1 POSSIBLE')
  assert.equal(shownNote(card), null)
  assert.equal(shownNote({ ...card, count: 12 }), 'Showing the top 3 of 12.')
})

test('the card: seller, count, each buyer with HOT/WARM, the score, the fit line and Open in Matches in a new tab', async () => {
  const { default: SellerMatchesCards } = await import('../SellerMatchesCard')
  const html = renderToStaticMarkup(createElement(SellerMatchesCards, { cards: [card] }))
  assert.ok(html.includes('Pat Example · Bedford-Stuyvesant'))
  assert.ok(html.includes('3 matching buyers · 2 HOT · 1 WARM'))
  assert.equal((html.match(/data-testid="seller-match-buyer"/g) ?? []).length, 3)
  for (const b of card.buyers) {
    assert.match(html, new RegExp(`<a [^>]*href="/matches\\?m=${b.matchId}"[^>]*target="_blank"[^>]*>`))
    assert.ok(html.includes(b.fit.replace("'", '&#x27;')), b.fit)
  }
  assert.ok(html.includes('2–3 family · Bedford-Stuyvesant · 3+ BR · $1.35M–$2.6M · cash'))
  assert.equal((html.match(/Open in Matches/g) ?? []).length, 3)
  assert.equal((html.match(/>HOT</g) ?? []).length, 2)
  assert.equal((html.match(/>WARM</g) ?? []).length, 1)
  assert.ok(html.includes('Match 92'))
  assert.equal((html.match(/Test buyer/g) ?? []).length, 2)
  assert.ok(!html.includes('88 Example Ave'), 'name and neighborhood only')
  assert.ok(!/tel:|https?:/i.test(html))
  assert.ok(!html.includes('Do not contact'))
})

test('an opted-out homeowner carries the Do not contact badge; no cards: nothing', async () => {
  const { default: SellerMatchesCards } = await import('../SellerMatchesCard')
  const html = renderToStaticMarkup(createElement(SellerMatchesCards, { cards: [{ ...card, seller: { ...card.seller, doNotContact: true } }] }))
  assert.ok(html.includes('Do not contact'))
  assert.equal(renderToStaticMarkup(createElement(SellerMatchesCards, { cards: [] })), '')
})
