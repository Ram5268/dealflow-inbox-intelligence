import { test } from 'node:test'
import assert from 'node:assert/strict'
import { outreachPriceText } from '../outreachPrice'
import { formatPriceRange } from '../../utils'

test('a seller contact never shows a price in outreach (its price is our estimate)', () => {
  assert.equal(outreachPriceText({ opportunityType: 'contact', price: 1_800_000, minPrice: null, maxPrice: null }), 'price on request')
})

test('an email listing keeps its price text exactly as before', () => {
  const s = { opportunityType: 'opportunity', price: 1_500_000, minPrice: null, maxPrice: null }
  assert.equal(outreachPriceText(s), formatPriceRange(null, null, 1_500_000))
  assert.notEqual(outreachPriceText(s), 'price on request')
  const noPrice = { opportunityType: 'opportunity', price: null, minPrice: null, maxPrice: null }
  assert.equal(outreachPriceText(noPrice), formatPriceRange(null, null, null) || 'price on request')
})
