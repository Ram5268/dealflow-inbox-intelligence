import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeForeclosureUrgency } from '../foreclosureUrgency'
import type { ListingData } from '../../scorerTypes'

// Brief 48 (PR 9 review r1): an auction date already past is unknown, not the most urgent.
const NOW = new Date('2026-10-23T12:00:00Z')
const at = (iso: string | null) => computeForeclosureUrgency({ foreclosureAuctionDate: iso ? new Date(iso) : null } as ListingData, NOW)

test('a coming auction is urgent; one long past, or a placeholder date, is unknown', () => {
  assert.deepEqual(at('2026-11-01T00:00:00Z'), { key: 'foreclosureUrgency', score: 1, confidence: 'HIGH' })
  assert.deepEqual(at('2026-10-23T00:00:00Z'), { key: 'foreclosureUrgency', score: 1, confidence: 'HIGH' }) // today
  assert.deepEqual(at('2027-06-01T00:00:00Z'), { key: 'foreclosureUrgency', score: 0.3, confidence: 'HIGH' })
  for (const past of ['2026-10-20T00:00:00Z', '2019-01-15T00:00:00Z', '1899-12-30T00:00:00Z']) {
    assert.deepEqual(at(past), { key: 'foreclosureUrgency', score: 0.5, confidence: 'LOW' }, past)
  }
  assert.deepEqual(at(null), { key: 'foreclosureUrgency', score: 0.5, confidence: 'LOW' })
})
