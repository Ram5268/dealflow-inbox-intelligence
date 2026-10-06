// Brief 41 (H9) — seller-lead extraction never asks for, or saves, estate /
// probate / divorce and similar personal circumstances. Pure (schemas.ts
// imports only zod, type-only SDK types and the pure helper).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXTRACTION_SPEC_BY_CATEGORY } from '../schemas'
import { mentionsPersonalCircumstances, safeMotivation, withoutPersonalCircumstances, safeLeadText, sellerSummary, leadFallbackTitle } from '../personalCircumstances'

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

test('the title and the classification reason are cleaned too (Brief 41 review)', () => {
  const row = EXTRACTION_SPEC_BY_CATEGORY.SELLER_LEAD!.mapItem(
    lead({ extractedTitle: 'Probate sale – 3-family in Bed-Stuy', classificationReason: 'Seller lead. Owner died in May.' }),
    ctx,
  )
  assert.equal(row.extractedTitle, 'Seller lead – 12 Example St')
  assert.equal(row.classificationReason, 'Seller lead.')
  const emptied = safeLeadText({ title: 'x', summary: 's', reason: 'The estate is selling.', fallbackTitle: 'Seller lead' })
  assert.equal(emptied.reason, 'Classified from the email; personal details left out.')
  assert.equal(leadFallbackTitle('LANDLORD_LEAD', null), 'Landlord lead')
})

test('one helper builds the stored summary for V1 and V2', () => {
  assert.equal(sellerSummary('Owner wants to list. Divorce pending.', 'downsizing'), 'Owner wants to list. Motivation: downsizing')
  assert.equal(sellerSummary('Owner wants to list.', 'mom passed in March'), 'Owner wants to list.')
  const v1 = readFileSync(join(ROOT, 'lib/ingestion/extractors/sellerLeadExtractor.ts'), 'utf8')
  assert.match(v1, /safeLeadText\(\{/)
  assert.match(v1, /input\.subject && !mentionsPersonalCircumstances\(input\.subject\)/)
  assert.doesNotMatch(v1, /extractedSummary:\s*l\.extractedSummary/)
})

test('every writer of seller/landlord free text uses the filter', () => {
  const landlord = EXTRACTION_SPEC_BY_CATEGORY.LANDLORD_LEAD!.mapItem(
    lead({ extractedTitle: 'Estate rental – owner died', extractedSummary: 'Two units. Owner died in May.', classificationReason: 'Landlord lead.' }),
    ctx,
  )
  assert.equal(landlord.extractedTitle, 'Landlord lead – 12 Example St')
  assert.equal(landlord.extractedSummary, 'Two units.')
  for (const f of ['lib/ai.ts', 'lib/extraction/extractEmailV2.ts', 'lib/ingestion/extractors/landlordLeadExtractor.ts']) {
    assert.match(readFileSync(join(ROOT, f), 'utf8'), /safeLeadText\(/, f)
  }
  const ai = readFileSync(join(ROOT, 'lib/ai.ts'), 'utf8')
  assert.match(ai, /return results\.map\(withoutPersonalLeadText\)/)
})

test('an ordinary motivation is still saved', () => {
  const row = EXTRACTION_SPEC_BY_CATEGORY.SELLER_LEAD!.mapItem(lead({ motivation: 'relocating to Boston for work' }), ctx)
  assert.equal(row.extractedSummary, 'Owner wants to list. Motivation: relocating to Boston for work')
})

test('the filter catches the sensitive words and leaves real-estate talk alone', () => {
  for (const s of ['probate', 'going through a divorce', 'divorcing', 'owner passed away', 'the deceased owner', 'heirs want to sell',
    'inherited the house', 'executor of the will', 'recently widowed', 'estate sale', 'the Smith estate',
    // Brief 41 review: phrasings the first version missed.
    'the will was probated', 'probating', 'executors', 'co-executors', 'mom passed in March', 'after her passing',
    'her late husband', 'passed  away', 'passed\naway', 'the owner is dead', 'owner dies', 'two deaths', 'the couple separated',
    'his ex-wife', 'terminally ill', 'owner is ill', 'cancer', 'moving to hospice', 'going into a nursing home',
    'assisted living', 'health reasons',
    // Round 2
    'legal separation', 'they separated last year', 'lost her husband', 'bereavement', 'letters testamentary',
    "Surrogate's Court filing", 'the owner died',
    // Round 3
    'The owner passed in March.', 'the owner has passed', 'Owner passed last month and the kids want to sell.',
    'her father has been ill', 'the seller got ill', 'Surrogate’s Court']) {
    assert.equal(mentionsPersonalCircumstances(s), true, s)
  }
  for (const s of ['real estate investor', 'relocating', 'downsizing', 'needs a bigger place', 'tired landlord',
    'real-estate investor', 'Real  estate', 'estate agent', 'Single-family home in Jamaica Estates, Queens',
    'Estates at Park Slope', 'estate-sized lot', 'the deal died at contract', 'interest died down', 'dying to move to Florida',
    'executive', 'deathly quiet', 'heirloom', 'their', 'inherent', 'still', 'ill-fated', 'passed inspection',
    // Round 2
    'Owner passed on our first offer.', 'relocating to Chicago, Ill.', 'ill-equipped kitchen',
    'owner is separating the two lots', 'dead-bolt locks', 'death-defying views',
    // Round 3
    'The owner passed the board.', 'The kitchen is ill-equipped.']) {
    assert.equal(mentionsPersonalCircumstances(s), false, s)
  }
  assert.equal(safeMotivation('  downsizing  '), 'downsizing')
  assert.equal(safeMotivation(null), null)
  assert.equal(withoutPersonalCircumstances('A. Divorce pending! B?'), 'A. B?')
  // Lines, quotes and abbreviations (Brief 41 review)
  assert.equal(withoutPersonalCircumstances('Owner wants to list\nDivorce pending\nThree units.'), 'Owner wants to list Three units.')
  assert.equal(withoutPersonalCircumstances('Owner said "my wife died." Three units.'), 'Three units.')
  assert.equal(withoutPersonalCircumstances('Seller Mr. Smith is the executor. Three units.'), 'Three units.')
  // A phrase split across lines never comes back whole: fail closed.
  assert.equal(withoutPersonalCircumstances('She passed\naway last year. Three units.'), '')
  // Nothing to drop: the text comes back exactly as it was, newlines included.
  assert.equal(withoutPersonalCircumstances('Three units.\nTenant in place.'), 'Three units.\nTenant in place.')
})
