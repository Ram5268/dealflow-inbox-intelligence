import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeFakePrisma, contact, sixHundredFifty, ORG_ROW } from '../../__tests__/pr5FakePrisma'
import type { ParsedQuery } from '@/lib/retrieval/types'

// Brief 43 PR 5 (Q6): the CRM-seller side block gives Drift counts only, never
// a seller's name, phone, address or notes (D11 [Ryan, 2026-10-18]), counted
// over every seller (no 20-row window), and no longer fires on "my buyer".
const rows = sixHundredFifty()
rows.push(contact({ fullName: 'Probe Buyer Contact', intent: 'BUYER', isTestData: true }))
const fake = makeFakePrisma({ organization: [ORG_ROW], mojoContact: rows, extractedOpportunity: [] })
;(globalThis as unknown as { prisma: unknown }).prisma = fake.prisma

const parsed = (over: Partial<ParsedQuery>): ParsedQuery => ({
  raw: '', neighborhoods: [], boroughs: [], beds: null, minBeds: null, maxBeds: null, minUnits: null, maxUnits: null,
  minPrice: null, maxPrice: null, isRental: null, categories: [], intent: 'general', isCalendar: false, isACRIS: false,
  isDOB: false, isMyBuyer: false, isSellerLead: false, isEmailCampaign: false, broaden: false,
  freshnessOverrideHours: null, usedLLM: false, confidence: 0, ...over,
} as ParsedQuery)
const run = async (p: Partial<ParsedQuery>, userMessage = 'which of my sellers are in Bed-Stuy?') => {
  const { mojoFetcher } = await import('../mojo')
  return (await mojoFetcher({ parsed: parsed(p), userMessage, queryText: userMessage.toLowerCase(), isConfirmMessage: false })).block
}

test('a neighborhood gives one count line over all 650 sellers, with no names, phones or addresses', async () => {
  const block = await run({ neighborhoods: ['Bedford-Stuyvesant'], isSellerLead: true })
  assert.ok(block)
  assert.match(block, /325 of your CRM sellers are in Bedford-Stuyvesant\./)
  assert.ok(!/\d{10}/.test(block), 'no 10-digit run')
  assert.ok(!/\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(block), 'no formatted phone')
  assert.ok(!/Probe|Example Ave|note/i.test(block), 'no names, addresses or notes')
  assert.ok(!/mojo/i.test(block), 'says "your CRM", not "Mojo"')
  assert.equal(fake.calls.filter(c => c.model === 'mojoContact').every(c => c.op === 'count'), true)
})

test('"my buyer" alone, or email-campaign words, no longer pull CRM sellers in', async () => {
  assert.equal(await run({ isMyBuyer: true }, 'anything for my buyer?'), null)
  assert.equal(await run({ isEmailCampaign: true }, 'who opened the email campaign?'), null)
})

test('seller words with no neighborhood give the total; a neighborhood with none is left out unless sellers were asked about', async () => {
  assert.match((await run({}, 'how many sellers do I have?')) ?? '', /You have 650 sellers in your CRM\./)
  assert.match((await run({ isSellerLead: true }, 'any seller leads?')) ?? '', /You have 650 sellers in your CRM\./)
  assert.equal(await run({}, 'draft a note to the seller'), null)
  assert.equal(await run({ neighborhoods: ['Tribeca'] }, 'anything coming soon in tribeca?'), null)
  assert.match((await run({ neighborhoods: ['Tribeca'] }, 'my sellers in tribeca?')) ?? '', /0 of your CRM sellers are in Tribeca\./)
})
