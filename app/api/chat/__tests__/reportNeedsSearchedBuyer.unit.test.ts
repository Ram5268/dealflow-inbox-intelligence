import { fake, script, driftCalls, reset, postChat, toolResultsSent, anthropicTools } from './pr9ChatHarness'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anthropicTool } from '../../../../lib/__tests__/fakeAiFetch'

// Brief 43 PR 9 (Q15; TEST_PLAN R-07, B-06; DRIFT_SCRIPT #15): a Buyer Match
// report, or a section of one, is made only for a buyer id that search_parties
// returned earlier in the same turn. A guessed id, an id from an earlier turn
// and an id from a search in the same round (Drift hasn't seen its results yet)
// get a tool error telling Drift to search first or ask Ryan which buyer
// [engineering precaution]. The real chat route, with fake Prisma and scripted
// AI replies; no database, no network. Every buyer and agent is fictional.

const buyer = (id: string, over: Record<string, unknown> = {}) => ({
  id, organizationId: 'org_pr9', category: 'BUYER_ISO', isDuplicate: false, processingStatus: 'active', provenance: null,
  extractedTitle: 'Buyer request', extractedSummary: 'Looking for a home.', sourceAgentName: null, buyerArchetype: null,
  neighborhood: 'Bushwick', neighborhoods: ['Bushwick'], borough: 'Brooklyn', beds: null, minBeds: 3, maxBeds: 4,
  minPrice: 1_500_000, maxPrice: 2_000_000, price: null, mustHaves: null, dealbreakers: null, timeline: null,
  propertyTypes: [], isTestData: true, confidenceScore: 0.9, createdAt: new Date(Date.UTC(2026, 9, 18)), ...over,
})
const JORDAN = buyer('iso_jordan', { extractedTitle: 'Jordan Sample: 3-family in Bed-Stuy', sourceAgentName: 'Casey Placeholder' })
const OTHER = buyer('iso_other', { extractedTitle: 'Condo buyer in Park Slope', sourceAgentName: 'Morgan Fictional' })

const REPORT = (buyerId?: string) => ['generate_report', { templateId: 'buyer-match', params: buyerId ? { buyerId } : {} }] as [string, unknown]
const SECTION = (buyerId?: string) => ['generate_report_section', { templateId: 'buyer-match', sectionKey: 'criteria', params: buyerId ? { buyerId } : {} }] as [string, unknown]
const reply = (response: string) => anthropicTool('drift_response', { response, suggestions: ['a', 'b'], referencedDeals: [] })
const reportsMade = () => fake.calls.filter(c => c.model === 'report' && c.op === 'create')
const refusals = () => toolResultsSent().filter(r => typeof r.error === 'string' && /search_parties/.test(String(r.error)))

test('a report for a name nobody has is refused, and Drift is told to ask (R-07)', async () => {
  reset([JORDAN, OTHER])
  script.push(anthropicTools(REPORT('iso_guessed')), reply('No buyer by that name on file. Which buyer do you mean?'))
  const { status, json } = await postChat({ message: 'buyer match report for Zorblax Quentin' })
  assert.equal(status, 200)
  assert.equal(reportsMade().length, 0, 'no report saved')
  assert.equal(json.attachedReport, null)
  const [refused] = refusals()
  assert.ok(refused, 'the tool result is a refusal')
  assert.match(String(refused.error), /call search_parties first/i)
  assert.match(String(refused.error), /ask which buyer/i)
  assert.match(String(refused.error), /never use the closest match/i)
})

test('a real buyer id that no tool returned this turn is refused too (no guessing, no id from history)', async () => {
  reset([JORDAN, OTHER])
  script.push(anthropicTools(REPORT(JORDAN.id)), reply('Which buyer do you mean?'))
  await postChat({ message: 'draft me a buyer match report for the Bed-Stuy buyer' })
  assert.equal(reportsMade().length, 0)
  assert.equal(refusals().length, 1)
})

test('a search in the same round does not count; after it, the same id works (DRIFT_SCRIPT #15)', async () => {
  reset([JORDAN, OTHER])
  script.push(
    anthropicTools(['search_parties', { query: 'Jordan Sample' }], REPORT(JORDAN.id)),
    anthropicTools(REPORT(JORDAN.id)),
    reply("Here's the Buyer Match report."),
  )
  const { json } = await postChat({ message: 'draft me a buyer match report for Jordan Sample' })
  assert.equal(driftCalls.length, 3)
  const made = reportsMade()
  assert.equal(made.length, 1, 'one report, made after the search came back')
  assert.equal((made[0].args.data as { buyerId?: string }).buyerId, JORDAN.id)
  assert.equal((json.attachedReport as { reportId?: string } | null)?.reportId, (fake.data.report[0] as { id: string }).id)
})

test("a search that found one buyer doesn't unlock a different one", async () => {
  reset([JORDAN, OTHER])
  script.push(
    anthropicTools(['search_parties', { query: 'Jordan Sample' }]),
    anthropicTools(REPORT(OTHER.id)),
    reply('Which buyer do you mean?'),
  )
  await postChat({ message: 'draft me a buyer match report for Jordan Sample' })
  assert.equal(reportsMade().length, 0)
  assert.equal(refusals().length, 1)
})

test('a report section needs the same: no id is refused, a searched id works', async () => {
  reset([JORDAN, OTHER])
  script.push(anthropicTools(SECTION()), reply('Which buyer do you mean?'))
  const refused = await postChat({ message: 'just the criteria for that buyer' })
  assert.equal(refused.json.attachedFragment, null)
  assert.equal(refusals().length, 1)

  reset([JORDAN, OTHER])
  script.push(
    anthropicTools(['search_parties', { query: 'Casey Placeholder' }]),
    anthropicTools(SECTION(JORDAN.id)),
    reply('They want a 3-family in Bed-Stuy.'),
  )
  const ok = await postChat({ message: "just the criteria for Casey Placeholder's buyer" })
  assert.equal((ok.json.attachedFragment as { sectionKey?: string } | null)?.sectionKey, 'criteria')
  assert.equal(refusals().length, 0)
})
