import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rankMatches, rankScoreFor, SOURCE_BOOST } from './ranking'
import type { MatchResult, SourceBadge, Tier } from './types'

// Run: `npm test`. Deterministic proof of the ranking invariants — no LLM, no DB.
// The SE-priority guarantee lives HERE (hardcoded boost), not in the tiering rubric.

let seq = 0
function mk(tier: Exclude<Tier, 'None'>, source: SourceBadge, recencyDays: number, id?: string): MatchResult {
  seq++
  return {
    id: id ?? `id${seq}`,
    party: { id: `p${seq}`, name: source, source, role: 'buyer', criteria: '' },
    listing: { id: `l${seq}`, address: null, neighborhood: null, price: null, category: 'ACTIVE_SALE_LISTING' as MatchResult['listing']['category'] },
    tier, reason: '', rankScore: rankScoreFor(tier, source), recencyDays, sourceBadge: source,
  }
}

test('within a tier, SE > Mojo > inbox', () => {
  const ranked = rankMatches([mk('Warm', 'inbox', 1), mk('Warm', 'mojo', 1), mk('Warm', 'streeteasy_expert', 1)])
  assert.deepEqual(ranked.map(r => r.sourceBadge), ['streeteasy_expert', 'mojo', 'inbox'])
})

test('tier dominates source: a Hot inbox outranks a Warm SE', () => {
  const ranked = rankMatches([mk('Warm', 'streeteasy_expert', 1), mk('Hot', 'inbox', 1)])
  assert.equal(ranked[0].tier, 'Hot')
  assert.equal(ranked[0].sourceBadge, 'inbox')
})

test('an SE party sorts first among ALL same-tier peers regardless of input order', () => {
  const ranked = rankMatches([
    mk('Hot', 'mojo', 1), mk('Hot', 'inbox', 1), mk('Hot', 'streeteasy_expert', 1), mk('Hot', 'inbox', 1),
  ])
  assert.equal(ranked[0].sourceBadge, 'streeteasy_expert')
})

test('recency breaks ties within same tier + source (newer first)', () => {
  const ranked = rankMatches([mk('Hot', 'mojo', 10), mk('Hot', 'mojo', 2)])
  assert.deepEqual(ranked.map(r => r.recencyDays), [2, 10])
})

test('id breaks ties within same tier + source + recency (stable order)', () => {
  const ranked = rankMatches([mk('Hot', 'inbox', 5, 'zzz'), mk('Hot', 'inbox', 5, 'aaa')])
  assert.deepEqual(ranked.map(r => r.id), ['aaa', 'zzz'])
})

test('source boost never bridges a tier gap (Warm SE 2100 < Hot inbox 3000)', () => {
  assert.ok(rankScoreFor('Warm', 'streeteasy_expert') < rankScoreFor('Hot', 'inbox'))
  assert.equal(SOURCE_BOOST.streeteasy_expert, 100)
})
