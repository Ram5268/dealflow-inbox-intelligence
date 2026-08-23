import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeAbsenteeOwner } from '../absenteeOwner'
import { makeListing } from '../../__tests__/fixtures'

test('absenteeOwner scoring table', () => {
  assert.deepEqual(
    computeAbsenteeOwner(makeListing({ ownerOccupied: false })),
    { key: 'absenteeOwner', score: 1.0, confidence: 'HIGH' },
  )
  assert.deepEqual(
    computeAbsenteeOwner(makeListing({ ownerOccupied: true })),
    { key: 'absenteeOwner', score: 0.4, confidence: 'HIGH' },
  )
  // null ownerOccupied + alternate address differs → absentee
  assert.equal(
    computeAbsenteeOwner(makeListing({
      ownerOccupied: null, address: '123 Main St, Brooklyn NY', alternateAddress: '9 Palm Ave, Miami FL',
    })).score,
    1.0,
  )
  // null ownerOccupied + no alternate address → unknown
  const unknown = computeAbsenteeOwner(makeListing({ ownerOccupied: null, alternateAddress: null }))
  assert.equal(unknown.score, 0.5)
  assert.equal(unknown.confidence, 'LOW')
})
