import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isEligible, isNeighborhoodEligible } from '../eligibility'
import { computeNeighborhood } from '../features/neighborhood'
import { precomputeSubstitutionCounts } from '../compsCache'
import { makeBuyer, makeListing } from './fixtures'

// Brief 35: borough-level areas. A seller labeled "Brooklyn" (borough known) and
// a buyer who asked for "Manhattan" are matched at borough level.
const brooklynLabel = makeListing({ id: 'bk', neighborhood: 'Brooklyn', borough: 'Brooklyn' })

test('seller borough label: eligible only for buyers wanting that borough', () => {
  assert.equal(isEligible(brooklynLabel, makeBuyer({ neighborhoods: ['Park Slope'] })).eligible, true)
  const r = isEligible(brooklynLabel, makeBuyer({ neighborhoods: ['Astoria'] }))
  assert.deepEqual(r, { eligible: false, reason: 'wrong_neighborhood' })
  assert.equal(isEligible(brooklynLabel, makeBuyer({ neighborhoods: ['Astoria', 'Bushwick'] })).eligible, true)
})

test('unknown sides still pass (unchanged)', () => {
  assert.equal(isNeighborhoodEligible('Brooklyn', ['Astoria'], null), true) // borough unknown → keep
  assert.equal(isNeighborhoodEligible('Park Slope', []), true) // buyer has no areas
  assert.equal(isNeighborhoodEligible('Park Slope', ['Xyzzy']), true) // buyer area unrecognized
})

test('buyer borough label: the whole borough, nothing else', () => {
  const manhattanBuyer = makeBuyer({ neighborhoods: ['Manhattan'] })
  assert.equal(isEligible(makeListing({ neighborhood: 'Chelsea' }), manhattanBuyer).eligible, true)
  assert.equal(isEligible(makeListing({ neighborhood: 'Park Slope' }), manhattanBuyer).eligible, false)
  assert.equal(isEligible(brooklynLabel, manhattanBuyer).eligible, false)
  assert.equal(isEligible(brooklynLabel, makeBuyer({ neighborhoods: ['Brooklyn'] })).eligible, true)
})

test('neighborhood feature: borough-only overlap scores 0.3 MEDIUM', () => {
  const med = { key: 'neighborhood', score: 0.3, confidence: 'MEDIUM' }
  assert.deepEqual(computeNeighborhood(brooklynLabel, makeBuyer({ neighborhoods: ['Park Slope'] })), med)
  assert.deepEqual(computeNeighborhood(makeListing({ neighborhood: 'Chelsea' }), makeBuyer({ neighborhoods: ['Manhattan'] })), med)
  assert.deepEqual(computeNeighborhood(brooklynLabel, makeBuyer({ neighborhoods: ['Brooklyn'] })), med)
})

test('neighborhood feature: exact / adjacent / same-borough unchanged; unknown stays LOW', () => {
  const buyer = makeBuyer({ neighborhoods: ['Park Slope'] })
  assert.deepEqual(computeNeighborhood(makeListing({ neighborhood: 'Park Slope' }), buyer), { key: 'neighborhood', score: 1.0, confidence: 'HIGH' })
  assert.equal(computeNeighborhood(makeListing({ neighborhood: 'Bushwick' }), buyer).confidence, 'HIGH')
  assert.equal(computeNeighborhood(makeListing({ neighborhood: 'Brooklyn', borough: null }), buyer).confidence, 'LOW')
  assert.equal(computeNeighborhood(brooklynLabel, makeBuyer()).confidence, 'LOW')
})

test('substitution counts apply the same borough gate', () => {
  const counts = precomputeSubstitutionCounts(
    [makeBuyer({ id: 'astoria', neighborhoods: ['Astoria'] }), makeBuyer({ id: 'slope', neighborhoods: ['Park Slope'] })],
    [brooklynLabel],
  )
  assert.equal(counts.get('astoria'), 0)
  assert.equal(counts.get('slope'), 1)
})
