import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SellerCard as Card } from '../../../lib/chat/sellerCard'

// Brief 43 PR 5 (D11 [Ryan, 2026-10-18]): the chat page's seller card. The
// phone is plain text (no tel: link), the CRM link is an "Open in CRM" button
// that opens a new tab, and an opted-out seller carries a "Do not contact"
// badge. Rendered to static HTML here; the executor checks it in a browser.
const card: Card = {
  kind: 'crm_seller', id: 'mc_pat', name: 'Pat Example', phone: '(718) 555-0142', address: '88 Example Ave',
  neighborhood: 'Bedford-Stuyvesant', lastCallResult: 'Left Message', status: 'No Answer', doNotContact: false,
  crmUrl: 'https://crm.example.test/leads/lead_pat',
}

test('splitStoredCards: seller cards come out of the stored cards, deals stay deals', async () => {
  const { splitStoredCards } = await import('../sellerCardView')
  const deal = { id: 'SEED_SALE_06', category: 'COMING_SOON_SALE' }
  assert.deepEqual(splitStoredCards([deal, card]), { deals: [deal], sellerCards: [card] })
  assert.deepEqual(splitStoredCards(undefined), { deals: [], sellerCards: [] })
  assert.deepEqual(splitStoredCards(null), { deals: [], sellerCards: [] })
})

test('the card shows name, phone as plain text, address and an Open in CRM button in a new tab', async () => {
  const { default: SellerCards } = await import('../SellerCard')
  const html = renderToStaticMarkup(createElement(SellerCards, { cards: [card] }))
  assert.ok(html.includes('Pat Example'))
  assert.ok(html.includes('(718) 555-0142'))
  assert.ok(html.includes('88 Example Ave'))
  assert.ok(html.includes('Bedford-Stuyvesant'))
  assert.ok(!/tel:/i.test(html), 'no tel: link')
  assert.match(html, /<a [^>]*href="https:\/\/crm\.example\.test\/leads\/lead_pat"[^>]*target="_blank"[^>]*>/)
  assert.ok(html.includes('Open in CRM'))
  assert.ok(!html.includes('Do not contact'))
})

test('an opted-out seller gets the "Do not contact" badge', async () => {
  const { default: SellerCards } = await import('../SellerCard')
  const html = renderToStaticMarkup(createElement(SellerCards, { cards: [{ ...card, doNotContact: true }] }))
  assert.ok(html.includes('Do not contact'))
})

test('no CRM link: no button; no cards: nothing at all', async () => {
  const { default: SellerCards } = await import('../SellerCard')
  const html = renderToStaticMarkup(createElement(SellerCards, { cards: [{ ...card, crmUrl: null }] }))
  assert.ok(!html.includes('Open in CRM'))
  assert.equal(renderToStaticMarkup(createElement(SellerCards, { cards: [] })), '')
})
