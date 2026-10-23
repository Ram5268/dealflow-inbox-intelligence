import { fake, script, reset, postChat, toolResultsSent, anthropicTools, ORG } from './pr9ChatHarness'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anthropicTool } from '../../../../lib/__tests__/fakeAiFetch'

// Brief 48 PR 13 (Q44; review r1): Drift's report tools pass Ryan's organization
// to the report after the tool's own params, as POST /api/reports does, so an
// organizationId in the params Drift writes can't change which organization the
// report reads [engineering precaution]. The real chat route, with fake Prisma
// and scripted AI replies; no database, no network. Fictional buyer.

const BUYER = {
  id: 'iso_pr13_org', organizationId: ORG, category: 'BUYER_ISO', isDuplicate: false, processingStatus: 'active', provenance: null,
  extractedTitle: 'Morgan Fictional: 2-family in Bushwick', extractedSummary: 'Looking for a home.', sourceAgentName: null, buyerArchetype: null,
  neighborhood: 'Bushwick', neighborhoods: ['Bushwick'], borough: 'Brooklyn', beds: 3.5, minBeds: 3, maxBeds: 4,
  minPrice: 1_500_000, maxPrice: 2_000_000, price: 1_750_000, mustHaves: null, dealbreakers: null, timeline: null,
  propertyTypes: [], isTestData: true, confidenceScore: 0.9, createdAt: new Date(Date.UTC(2026, 9, 18)),
}
const reply = (response: string) => anthropicTool('drift_response', { response, suggestions: ['a', 'b'], referencedDeals: [] })

test("an organizationId in Drift's report params doesn't change the report's organization", async () => {
  for (const [tool, extra] of [['generate_report', {}], ['generate_report_section', { sectionKey: 'criteria' }]] as const) {
    reset([BUYER])
    script.push(
      anthropicTools(['search_parties', { query: 'Morgan Fictional' }]),
      anthropicTools([tool, { templateId: 'buyer-match', ...extra, params: { buyerId: BUYER.id, organizationId: 'org_other' } }]),
      reply('Done.'),
    )
    const { status } = await postChat({ message: 'buyer match report for Morgan Fictional' })
    assert.equal(status, 200)
    const errors = toolResultsSent().filter(r => typeof r.error === 'string')
    assert.deepEqual(errors, [], tool)
    if (tool === 'generate_report') assert.equal(fake.calls.filter(c => c.model === 'report' && c.op === 'create').length, 1)
  }
})
