// Brief 43 PR 10 (Q17; M19): the guard counts a source, a deed fact or an
// entity only when this turn fetched it, and lets honest declines through.
//
// - The grounding is this turn's tool results and side-lookup blocks (plus the
//   prior turn's cards for entity names), not RYAN_MD, which names ACRIS, DOB
//   and StreetEasy and so made every invented "per ACRIS" look grounded.
// - Deed facts (owner names, sale amounts, sale years) bind to this turn's
//   ACRIS block; a source name binds to its own block (ACRIS, DOB, live
//   StreetEasy) or to this turn's tool results.
// - "I can't check Zillow" is a decline, not a citation; "Two LLC-owned
//   sellers" names no entity; "I don't have a record of that sale" asserts no
//   sale (DRIFT_SCRIPT #8).
// - Any URL Drift writes stays a hard flag: links reach Ryan as buttons.
// Deed-owner names may be shown: D1 [Ryan, 2026-10-17]. The rest is an
// [engineering precaution]. Pure tests: fictional names and addresses only, no
// API, no database, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanForStructuralHallucinations, type RegexFlag } from '../regexGuard'
import { buildGuardGrounding, filterToolBoundFlags } from '../toolBinding'
import { formatForChat } from '../../../acris'
import { ACRIS_RESULT, ACRIS, DOB, SE, LLC_SELLERS, PRIOR_CARDS, side, PASS, FLAG, type Turn } from './guardAccuracy.fixtures'

// The route's guard step: scan, then drop what this turn's grounding supports.
function guard(reply: string, turn: Turn = {}): RegexFlag[] {
  const grounding = buildGuardGrounding(turn.tools ?? [], turn.prior ?? null, turn.side ?? side())
  return filterToolBoundFlags(scanForStructuralHallucinations(reply, { userMessage: turn.userMessage }), grounding, reply)
}
const show = (f: RegexFlag[]) => JSON.stringify(f.map(x => `${x.pattern}:${x.match}`))

for (const [label, reply, turn] of PASS) {
  test(`passes: ${label}`, () => {
    const flags = guard(reply, turn)
    assert.deepEqual(flags, [], `expected no flags for ${JSON.stringify(reply)}, got ${show(flags)}`)
  })
}

for (const [label, reply, turn] of FLAG) {
  test(`flags: ${label}`, () => {
    const flags = guard(reply, turn)
    assert.ok(flags.length > 0, `expected a flag for ${JSON.stringify(reply)}`)
  })
}

// ── Which flag, for the rows where it matters ────────────────────────────────
test('a URL stays external_url even when the block holds that exact link', () => {
  const flags = guard('One fits: https://streeteasy.com/rental/1234567', { side: side(SE) })
  assert.deepEqual(flags.map(f => f.pattern), ['external_url'], show(flags))
})

test('a wrong owner is flagged with its name, so the rewrite knows what to drop', () => {
  const flags = guard('The current owner is Casey Placeholder.', { side: side(ACRIS) })
  assert.deepEqual(flags.map(f => `${f.pattern}:${f.match}`), ['ownership_assertion:owner is Casey Placeholder'])
})

test('a named LLC flag carries the entity name only, not the words before it', () => {
  const flags = scanForStructuralHallucinations('The owner is Example Street Holdings LLC.')
  assert.deepEqual(flags.filter(f => f.pattern === 'corporate_entity').map(f => f.match), ['Example Street Holdings LLC'])
})

test('a named LLC from this turn\'s tool results is grounded even mid-sentence', () => {
  // The old match ran from "The" to the suffix, so it never traced.
  assert.deepEqual(guard('The owner on the card is Example Street Holdings LLC.', { tools: LLC_SELLERS }).filter(f => f.pattern === 'corporate_entity'), [])
})

test('the ACRIS block is read from its header to the next blank line (formatForChat has no blank line)', () => {
  assert.equal(formatForChat(ACRIS_RESULT).includes('\n\n'), false)
  // A deed fact in a later block (here the CRM block) doesn't count as ACRIS's.
  const crmOwner = '\n\nMOJO SELLER LEADS (1 contacts from CRM):\n[MOJO:c9] Casey Placeholder | 88 Example Ave, Brooklyn | Bed-Stuy | active | sellers | ph: (718) 555-0150'
  assert.ok(guard('The owner is Casey Placeholder.', { side: side(ACRIS, crmOwner) }).length > 0)
})

test('without a response the deed flags are kept (old callers)', () => {
  const grounding = buildGuardGrounding([], null, side(ACRIS))
  const flags = scanForStructuralHallucinations('It last sold in 2019 for $1,200,000.')
  assert.deepEqual(filterToolBoundFlags(flags, grounding).map(f => f.pattern), ['historical_sale_verb'])
})

test('a plain corpus string still works as before (Brief 11.0 / 26.0 callers)', () => {
  // The old API: a source name or entity present in the string is grounded.
  const flags: RegexFlag[] = [
    { pattern: 'real_estate_source_citation', match: 'DOB' },
    { pattern: 'corporate_entity', match: 'Example Street Holdings LLC' },
    { pattern: 'external_url', match: 'https://streeteasy.com/x' },
  ]
  const corpus = 'dob records 88 example ave example street holdings llc https streeteasy com x'
  assert.deepEqual(filterToolBoundFlags(flags, corpus).map(f => f.pattern), ['external_url'])
})

// ── Route wiring ─────────────────────────────────────────────────────────────
test('route: the grounding is this turn\'s tool results and side lookups, not RYAN_MD', () => {
  const src = readFileSync(join(__dirname, '../../../../app/api/chat/route.ts'), 'utf8')
  const call = src.match(/const groundingCorpus = buildGuardGrounding\(([^)]*)\)/)
  assert.ok(call, 'the route builds its grounding with buildGuardGrounding')
  assert.match(call[1], /toolResultsForGuard, priorDealCards, dynamicSystemBlock/)
  assert.doesNotMatch(call[1], /RYAN_MD|sideChannelText/)
  // The deed binding reads the reply it checks.
  assert.match(src, /groundingCorpus,\s*currentResponse,?\s*\)/)
})

// ── Speed: no regex blow-up (Node 22 and 24) ─────────────────────────────────
test('the scan and the binding stay fast on 20 KB inputs', () => {
  const grounding = buildGuardGrounding(LLC_SELLERS, PRIOR_CARDS, side(ACRIS, DOB, SE))
  const inputs = [
    'Zillow. '.repeat(2_500),
    "I can't check Zillow, ".repeat(900),
    'Example Holdings LLC '.repeat(1_000),
    'The owner is Pat Example and '.repeat(700),
    'It last sold in 2019 for $1,200,000; '.repeat(550),
    '$1,200,000 in 2019 '.repeat(1_000),
    'streeteasy.com/'.repeat(1_300),
    'a-'.repeat(10_000),
    'Aaaa '.repeat(4_000) + 'LLC',
    "I don't have a record of who it was sold to, ".repeat(450),
    'Pat Example Sample bought it '.repeat(700),
    ' '.repeat(20_000) + 'StreetEasy',
  ]
  for (const input of inputs) {
    const t = process.hrtime.bigint()
    filterToolBoundFlags(scanForStructuralHallucinations(input), grounding, input)
    const ms = Number(process.hrtime.bigint() - t) / 1e6
    assert.ok(ms < 250, `took ${ms.toFixed(1)} ms on a ${input.length}-char input starting ${JSON.stringify(input.slice(0, 30))}`)
  }
})
