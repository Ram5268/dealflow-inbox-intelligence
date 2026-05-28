// Unit tests for lib/retrieval/reconcile.ts:reconcileIntent.
// Project has no Jest/Vitest, so this script runs assertions inline and
// exits 1 on failure. Run via:  npx tsx scripts/test-reconcile.ts

import { Category } from '@prisma/client'
import type { ParsedQuery } from '../lib/retrieval/types'
import { reconcileIntent } from '../lib/retrieval/reconcile'

let failures = 0
function assert(cond: boolean, label: string, extra?: unknown): void {
  if (cond) {
    console.log(`  ✅ ${label}`)
  } else {
    console.log(`  ❌ ${label}`, extra !== undefined ? JSON.stringify(extra) : '')
    failures++
  }
}

// Minimal ParsedQuery factory — fills the non-test fields with neutral defaults
// so each test only states the fields under test.
function makeParsed(overrides: Partial<ParsedQuery>): ParsedQuery {
  return {
    raw:             '',
    neighborhoods:   [],
    boroughs:        [],
    beds:            null,
    minBeds:         null,
    maxBeds:         null,
    minPrice:        null,
    maxPrice:        null,
    isRental:        null,
    categories:      [],
    intent:          'general',
    isCalendar:      false,
    isACRIS:         false,
    isDOB:           false,
    isMyBuyer:       false,
    isSellerLead:    false,
    isEmailCampaign: false,
    usedLLM:         false,
    confidence:      0.5,
    ...overrides,
  }
}

function sameSet(a: Category[], b: string[]): boolean {
  return a.length === b.length && new Set<string>(a).size === new Set<string>([...a, ...b]).size
}

console.log('reconcileIntent unit tests\n')

// Test 1: isRental=true + a sale category → drop the sale category
{
  const out = reconcileIntent(makeParsed({ isRental: true, categories: ['ACTIVE_SALE_LISTING'] }))
  assert(sameSet(out.categories, []), 'isRental=true drops a lone ACTIVE_SALE_LISTING', out)
  assert(out.isRental === true,        'isRental flag passes through unchanged')
}

// Test 2: isRental=true with mixed rental + sale categories → only rental survives
{
  const out = reconcileIntent(makeParsed({
    isRental: true,
    categories: ['RENTAL_LISTING', 'ACTIVE_SALE_LISTING'],
  }))
  assert(sameSet(out.categories, ['RENTAL_LISTING']),
    'isRental=true keeps RENTAL_LISTING, drops ACTIVE_SALE_LISTING', out)
}

// Test 3: isRental=false with mixed categories → only sale survives
{
  const out = reconcileIntent(makeParsed({
    isRental: false,
    categories: ['RENTAL_LISTING', 'ACTIVE_SALE_LISTING'],
  }))
  assert(sameSet(out.categories, ['ACTIVE_SALE_LISTING']),
    'isRental=false keeps ACTIVE_SALE_LISTING, drops RENTAL_LISTING', out)
}

// Test 4: isRental=null → no override, both categories survive
{
  const out = reconcileIntent(makeParsed({
    isRental: null,
    categories: ['RENTAL_LISTING', 'ACTIVE_SALE_LISTING'],
  }))
  assert(sameSet(out.categories, ['RENTAL_LISTING', 'ACTIVE_SALE_LISTING']),
    'isRental=null does not override; both categories pass through', out)
}

// Test 5: isRental=true + empty categories → no crash, empty out
{
  const out = reconcileIntent(makeParsed({ isRental: true, categories: [] }))
  assert(sameSet(out.categories, []), 'isRental=true + empty input → empty output', out)
}

// Bonus: a non-sale, non-rental category (BUYER_ISO) passes through regardless
{
  const out = reconcileIntent(makeParsed({ isRental: true, categories: ['BUYER_ISO'] }))
  assert(sameSet(out.categories, ['BUYER_ISO']),
    'isRental=true does not affect demand categories (BUYER_ISO survives)', out)
}

// Bonus: all sale-side categories from SUPPLY_SALE get dropped under isRental=true
{
  const out = reconcileIntent(makeParsed({
    isRental: true,
    categories: ['ACTIVE_SALE_LISTING', 'OFF_MARKET_SALE', 'COMING_SOON_SALE', 'PRICE_DROP',
                 'BACK_ON_MARKET', 'DEVELOPMENT_INVENTORY', 'SPONSOR_UNIT', 'COMING_SOON_DEVELOPMENT'],
  }))
  assert(sameSet(out.categories, []), 'isRental=true drops every SUPPLY_SALE category', out)
}

console.log()
if (failures > 0) {
  console.log(`❌ ${failures} test(s) failed`)
  process.exit(1)
}
console.log('✅ All tests passed')
