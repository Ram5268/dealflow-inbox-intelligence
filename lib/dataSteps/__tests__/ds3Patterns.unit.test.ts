// Brief 48 DS-3: which Match rows are the old matcher's. Its five notes are
// matched anchored at both ends, together with the row's shape; the nightly's,
// the 7.0 engine's, showing confirmations' and hotsheet notes never are.
// Made-up titles and names only; no DB.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GATING_MENTIONS, isHotsheetNote, legacyKind, looksLegacy, planDs3, ds3Refusals, type Ds3Candidate, type MatchShape } from '../ds3LegacyMatches'

// The notes exactly as lib/matchmaking.ts builds them (main 0342554, unchanged since it was written).
const listing = { extractedTitle: 'Two-family in Example Heights' }
const iso = { extractedTitle: 'Buyer for a two-family, Example Heights' }
const inq = { extractedTitle: 'Renter wants a 2BR' }
const rental = { extractedTitle: '2BR rental, Sample Park' }
const mojo = { fullName: 'Pat Example', address: '88 Example Ave' }
const score = 72
const NOTES = {
  listing_iso: `${listing.extractedTitle} may match ISO: ${iso.extractedTitle} (score ${score})`,
  listing_renter: `${listing.extractedTitle} may match renter: ${inq.extractedTitle} (score ${score})`,
  iso_listing: `ISO: ${iso.extractedTitle} may match ${listing.extractedTitle} (score ${score})`,
  mojo_lead_iso: `Mojo lead ${mojo.fullName} at ${mojo.address} may match ISO: ${iso.extractedTitle}`,
  renter_listing: `Renter inquiry may match ${rental.extractedTitle} (score ${score})`,
} as const

const row = (reason: string, over: Partial<MatchShape> = {}): MatchShape =>
  ({ reason, tier: null, opportunityType: 'opportunity', counterpartType: 'opportunity', score, opportunityAddress: null, ...over })

test('each of the five old-matcher notes is recognised, with the shape it was written with', () => {
  for (const [kind, reason] of Object.entries(NOTES)) {
    const counterpartType = kind === 'mojo_lead_iso' ? 'mojo' : 'opportunity'
    assert.equal(legacyKind(row(reason, { counterpartType, score: kind === 'mojo_lead_iso' ? 40 : score })), kind, reason)
  }
  // A null address in the Mojo note ("at null") and a title with a line break still count.
  assert.equal(legacyKind(row('Mojo lead Pat Example at null may match ISO: Buyer', { counterpartType: 'mojo' })), 'mojo_lead_iso')
  assert.equal(legacyKind(row('Renter inquiry may match 2BR\nrental (score 72)')), 'renter_listing')
  assert.equal(legacyKind(row('Two-family may match ISO: Buyer (score -3)', { score: -3 })), 'listing_iso')
})

test("the nightly's, the engine's and showing-confirmation notes never match", () => {
  // Nightly (lib/matching/fitReason.ts style) and engine notes always carry a tier.
  for (const reason of ['Same neighborhood, price fits; weaker on beds', 'Matched on beds, baths', 'Good fit for this buyer',
    'exact Bushwick match with $1.2M inside the $1.1–1.3M budget, both fresh']) {
    for (const tier of ['HOT', 'WARM', 'POSSIBLE']) {
      assert.equal(legacyKind(row(reason, { tier, opportunityType: 'contact' })), null)
      assert.equal(legacyKind(row(reason, { tier, counterpartType: 'mojo' })), null)
    }
  }
  // Even an old-looking note with a tier is not the old matcher's.
  assert.equal(legacyKind(row(NOTES.listing_iso, { tier: 'HOT' })), null)
  assert.equal(legacyKind(row(NOTES.listing_iso, { opportunityType: 'contact' })), null)
  // Showing confirmations: own counterpart type, no tier, and a note that ends otherwise.
  const showing = `Showing confirmation: ${listing.extractedTitle} may match ISO: x (score 90) at 12 Sample St on Oct 3. Add to your Outlook calendar?`
  assert.equal(legacyKind(row(showing, { counterpartType: 'showing_confirmation', score: 90 })), null)
  assert.equal(legacyKind(row(showing, { score: 90 })), null)
  assert.equal(legacyKind(row(NOTES.listing_iso, { counterpartType: 'showing_confirmation' })), null)
})

test('anchored: text after the score, or a note on the wrong counterpart type, is not the old matcher', () => {
  assert.equal(legacyKind(row(`${NOTES.listing_iso}.`)), null)
  assert.equal(legacyKind(row(`${NOTES.listing_iso} Extra`)), null)
  assert.equal(legacyKind(row(NOTES.mojo_lead_iso)), null) // the Mojo note was always counterpartType 'mojo'
  assert.equal(legacyKind(row(NOTES.listing_iso, { counterpartType: 'mojo' })), null)
  assert.equal(legacyKind(row(`Note: ${NOTES.mojo_lead_iso}`, { counterpartType: 'mojo' })), null)
  assert.equal(legacyKind(row('')), null)
  assert.equal(legacyKind({ ...row('x'), reason: null }), null)
})

test("the score in the note must be the row's score; a look-alike is counted, never removed", () => {
  const r = row(NOTES.listing_iso, { score: 99 })
  assert.equal(legacyKind(r), null)
  assert.equal(looksLegacy(r.reason), true)
  assert.equal(looksLegacy('Same neighborhood'), false)
})

test("hotsheet notes (kept, Ryan 1.9) are never the old matcher's, even when the buyer's title starts with ISO:", () => {
  const hs = `12 Sample St (hotsheet) may match ISO: two-family buyer (score 70)`
  assert.equal(isHotsheetNote({ reason: hs, opportunityAddress: '12 Sample St' }), true)
  assert.equal(legacyKind(row(hs, { score: 70, opportunityAddress: '12 Sample St' })), null)
  assert.equal(legacyKind(row(hs, { score: 70 })), null) // address unknown: still kept
  assert.equal(legacyKind(row('12 Sample St (hotsheet) may match renter: Renter (score 70)', { score: 70 })), null)
})

test('a very long note is classified quickly (no runaway backtracking)', () => {
  const long = `${'x may match '.repeat(2000)}ISO: ${'y'.repeat(5000)} (score 5`
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < 20; i++) legacyKind(row(long, { score: 5 }))
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 2000)
})

const cand = (id: string, reason: string, over: Partial<Ds3Candidate> = {}): Ds3Candidate =>
  ({ id, organizationId: 'org-ryan', ...row(reason), ...over })

test("the plan: Ryan's organization's old-matcher rows only; hotsheet and look-alikes kept and counted", () => {
  const p = planDs3('org-ryan', [
    cand('m1', NOTES.listing_iso), cand('m4', NOTES.mojo_lead_iso, { counterpartType: 'mojo', score: 40 }),
    cand('m5', NOTES.renter_listing), cand('o1', NOTES.listing_iso, { organizationId: 'org-demo' }),
    cand('h1', '12 Sample St (hotsheet) may match Buyer (score 72)'), cand('n1', NOTES.iso_listing, { score: 1 }),
    cand('w1', 'Same neighborhood may match nothing', { tier: 'WARM' }),
  ], [], [], null)
  assert.deepEqual(p.remove, ['m1', 'm4', 'm5'])
  assert.equal(p.byKind.listing_iso, 1)
  assert.equal(p.byKind.mojo_lead_iso, 1)
  assert.equal(p.otherOrganizations, 1)
  assert.equal(p.hotsheetKept, 1)
  assert.equal(p.nearMisses, 1)
  assert.equal(p.referenced, false)
  assert.deepEqual(ds3Refusals(p, false), [])
})

test('used by the call list, feedback or chat/Drift/reports: refused unless --allow-referenced; then those ids are dropped', () => {
  const candidates = [cand('m1', NOTES.listing_iso), cand('m2', NOTES.listing_renter)]
  const p = planDs3('org-ryan', candidates,
    [{ id: 'q1', primaryMatchId: 'm1', contributingMatchIds: ['n1', 'm2'] }],
    [{ id: 'f1', opportunityId: 'o1', matchId: 'm2' }], null)
  assert.equal(p.referenced, true)
  assert.match(ds3Refusals(p, false).join(' '), /--allow-referenced/)
  assert.deepEqual(ds3Refusals(p, true), [])
  assert.deepEqual(p.changeQueue, [{ id: 'q1', from: { primaryMatchId: 'm1', contributingMatchIds: ['n1', 'm2'] }, to: { primaryMatchId: null, contributingMatchIds: ['n1'] } }])
  assert.deepEqual(p.changeFeedback, [{ id: 'f1', from: { opportunityId: 'o1', matchId: 'm2' }, to: { opportunityId: 'o1', matchId: null } }])
  // A chat/Drift mention alone counts as use; an AuditLog mention (history) never blocks.
  assert.ok(!GATING_MENTIONS.some(l => l.startsWith('AuditLog')))
  const viaDrift = planDs3('org-ryan', candidates, [], [], { 'DriftInteraction (cards shown)': 1, 'AuditLog (log entries)': 3 })
  assert.equal(viaDrift.referenced, true)
  const viaLog = planDs3('org-ryan', candidates, [], [], { 'AuditLog (log entries)': 3 })
  assert.equal(viaLog.referenced, false)
})
