// Brief 43 PR 1: the /matches outreach drafts sign "Ryan Martin" only, with no
// brokerage name and no job title. D2 [Brief 42 default]; no brokerage name or
// job title in anything sent [planner, 2026-10-19]. Pure: no database, no AI.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { draftOutreachSystemPrompt } from '../draftPrompt'
import type { ResolvedSupply } from '../supplyResolver'

const base: ResolvedSupply = {
  id: 'supply_1',
  opportunityType: 'opportunity',
  category: null,
  address: '88 Example Ave',
  neighborhood: 'Bedford-Stuyvesant',
  borough: 'Brooklyn',
  price: 1_850_000,
  minPrice: null,
  maxPrice: null,
  beds: 3,
  squareFeet: null,
  extractedTitle: '88 Example Ave',
  sourceBrokerage: null,
  sourceAgentName: null,
  availabilityDate: null,
  agreedToSell: false,
  propertyTypeText: '3-family',
  unitCount: 3,
}
const party = { name: 'Pat Example', role: 'buyer ISO', budget: '$1.5M–$2.0M', beds: '3BR', neighborhood: 'Bedford-Stuyvesant' }

for (const channel of ['email', 'text'] as const) {
  for (const supply of [base, { ...base, opportunityType: 'contact', price: null, extractedTitle: 'Homeowner in Bedford-Stuyvesant' }]) {
    test(`${channel} draft (${supply.opportunityType}) signs "Ryan Martin" only`, () => {
      const prompt = draftOutreachSystemPrompt({ channel, party, supply, matchReason: 'Right neighborhood, bedroom count' })
      assert.ok(!prompt.includes('Douglas Elliman'), 'no brokerage name')
      assert.ok(!/Elliman/i.test(prompt), 'no brokerage name, in any form')
      assert.match(prompt, /Sign off "Ryan Martin" only/)
      assert.match(prompt, /no brokerage name or job title/i)
    })
  }
}
