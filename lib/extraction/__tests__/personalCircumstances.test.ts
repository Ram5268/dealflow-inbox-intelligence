// Brief 41 (H9) — seller-lead extraction never asks for, or saves, estate /
// probate / divorce and similar personal circumstances. Pure (schemas.ts
// imports only zod, type-only SDK types and the pure helper).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXTRACTION_SPEC_BY_CATEGORY } from '../schemas'
import { mentionsPersonalCircumstances, safeMotivation, withoutPersonalCircumstances } from '../personalCircumstances'

const ROOT = join(__dirname, '..', '..', '..')
const ctx = { subject: 's', senderName: null, senderEmail: null }
const lead = (over: Record<string, unknown>) => ({
  address: '12 Example St', neighborhood: 'Park Slope', borough: 'Brooklyn', city: null, state: null, zip: null,
  price: null, beds: null, baths: null, squareFeet: null, units: null, propertyType: 'townhouse',
  availabilityDate: null, status: null, sourceAgentName: 'Agent', sourceAgentEmail: null, sourceBrokerage: null,
  motivation: null, extractedTitle: 'Seller lead', extractedSummary: 'Owner wants to list.', classificationReason: 'x', confidenceScore: 0.9,
  ...over,
})

test('neither seller-lead prompt asks for estate or divorce motivation, and both say never to record it', () => {
  const v2 = EXTRACTION_SPEC_BY_CATEGORY.SELLER_LEAD!.systemPrompt
  const v1 = readFileSync(join(ROOT, 'lib/ingestion/extractors/sellerLeadExtractor.ts'), 'utf8')
  for (const [name, prompt] of [['V2', v2], ['V1', v1]] as const) {
    assert.doesNotMatch(prompt, /\((estate|divorce), (estate|divorce)/, name)
    assert.match(prompt, /Never record personal circumstances/, name)
  }
})

test('a motivation about probate, death or divorce is dropped before saving; the summary keeps the rest', () => {
  const row = EXTRACTION_SPEC_BY_CATEGORY.SELLER_LEAD!.mapItem(
    lead({
      motivation: 'probate - owner passed away, heirs divorcing',
      extractedSummary: 'Owner wants to list. The estate is in probate after the owner died. Three units, tenant in place.',
    }),
    ctx,
  )
  assert.equal(row.extractedSummary, 'Owner wants to list. Three units, tenant in place.')
})

test('an ordinary motivation is still saved', () => {
  const row = EXTRACTION_SPEC_BY_CATEGORY.SELLER_LEAD!.mapItem(lead({ motivation: 'relocating to Boston for work' }), ctx)
  assert.equal(row.extractedSummary, 'Owner wants to list. Motivation: relocating to Boston for work')
})

test('the filter catches the sensitive words and leaves real-estate talk alone', () => {
  for (const s of ['probate', 'going through a divorce', 'divorcing', 'owner passed away', 'the deceased owner', 'heirs want to sell',
    'inherited the house', 'executor of the will', 'recently widowed', 'estate sale', 'the Smith estate']) {
    assert.equal(mentionsPersonalCircumstances(s), true, s)
  }
  for (const s of ['real estate investor', 'relocating', 'downsizing', 'needs a bigger place', 'tired landlord']) {
    assert.equal(mentionsPersonalCircumstances(s), false, s)
  }
  assert.equal(safeMotivation('  downsizing  '), 'downsizing')
  assert.equal(safeMotivation(null), null)
  assert.equal(withoutPersonalCircumstances('A. Divorce pending! B?'), 'A. B?')
})
