// Brief 48 PR 19 [Ryan 1.11]: the 20 report templates that don't work are
// removed, the locked Seller Activity report among them. The Buyer Match report
// stays: it works, and Drift uses it. The templates are code
// (lib/reports/templates.ts), not database rows, so no data changes; reports
// already saved are all Buyer Match reports (the only one that could be made).
// Every place that lists or picks a template is checked here: the catalog, the +
// button's sheet, the reports API, Drift's tools, its instructions and playbook.
// Pure; the route runs on a stand-in for Prisma. No database, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { makeFakePrisma, ORG_ROW } from './pr13FakePrisma'

const fake = makeFakePrisma({ organization: [ORG_ROW], chatSession: [], report: [], chatMessage: [] })
;(globalThis as unknown as { prisma: unknown }).prisma = fake.prisma

const ROOT = join(__dirname, '..', '..', '..')
const src = (f: string) => readFileSync(join(ROOT, f), 'utf8')

// The 20 removed templates: id, code and name.
const REMOVED: Array<[string, string, string]> = [
  ['cma', 'P-01', 'Comparative Market Analysis'],
  ['price-adjustment-memo', 'P-02', 'Price Adjustment Memo'],
  ['new-dev-price-schedule', 'P-03', 'New Development Unit Price Schedule'],
  ['absorption-velocity', 'P-04', 'Absorption & Velocity'],
  ['rental-pricing-rent-roll', 'P-05', 'Rental Pricing & Rent Roll'],
  ['acquisition-screening', 'U-01', 'Acquisition Screening'],
  ['development-pro-forma', 'U-02', 'Development Pro Forma'],
  ['investment-committee-memo', 'U-03', 'Investment Committee Memo'],
  ['highest-best-use', 'U-04', 'Highest & Best Use'],
  ['seller-activity', 'M-01', 'Seller Activity'],
  ['listing-launch-plan', 'M-03', 'Listing Launch Plan'],
  ['offer-comparison', 'M-04', 'Offer Comparison'],
  ['monthly-project-status', 'C-01', 'Monthly Project Status'],
  ['draw-request-summary', 'C-02', 'Draw Request'],
  ['change-order-log', 'C-03', 'Change Order'],
  ['quarterly-lp-update', 'I-01', 'Quarterly LP Update'],
  ['capital-call-notice', 'I-02', 'Capital Call'],
  ['disposition-closeout', 'I-03', 'Disposition & Closeout'],
  ['team-pipeline-production', 'O-01', 'Team Pipeline'],
  ['market-snapshot', 'O-02', 'Market Snapshot'],
]

test('the Buyer Match report is the only template, and it can be made', async () => {
  const { REPORT_TEMPLATES, getTemplate } = await import('../templates')
  const { GENERATOR_REGISTRY } = await import('../generators')
  const { SECTION_RUNNERS } = await import('../generators/buyer-match')
  assert.deepEqual(REPORT_TEMPLATES.map(t => t.id), ['buyer-match'])
  const t = getTemplate('buyer-match')!
  assert.equal(t.isUnlocked, true)
  assert.ok(GENERATOR_REGISTRY[t.id], 'it has a generator')
  assert.deepEqual(t.sections.map(s => s.key), Object.keys(SECTION_RUNNERS))
})

test('the 20 removed templates, the locked seller report among them, are not in the catalog', async () => {
  const { getTemplate, REPORT_TEMPLATES } = await import('../templates')
  for (const [id, code] of REMOVED) {
    assert.equal(getTemplate(id), undefined, id)
    assert.ok(!REPORT_TEMPLATES.some(t => t.code === code), code)
  }
})

test('the reports API refuses a removed template as unknown', async () => {
  const { POST } = await import('../../../app/api/reports/route')
  for (const templateId of ['seller-activity', 'cma', 'market-snapshot']) {
    const res = await POST(new NextRequest('http://localhost/api/reports', {
      method: 'POST', body: JSON.stringify({ templateId, params: { buyerId: 'buyer_1' }, writeToChat: true }),
    }))
    assert.equal(res.status, 400, templateId)
    assert.match((await res.json()).error, /^Unknown template/, templateId)
  }
  assert.equal(fake.tables.report.length + fake.tables.chatSession.length, 0, 'nothing saved')
})

test("Drift's tools, instructions and playbook name no removed template and no locked ones", async () => {
  const { RYAN_MD } = await import('../../prompts/ryanMd')
  const { SYSTEM_PROMPT } = await import('../../chat/systemPrompt')
  const { GENERATE_REPORT_TOOL, GENERATE_REPORT_SECTION_TOOL } = await import('../../chat/tools/schemas')
  const texts: Array<[string, string]> = [
    ['RYAN_MD', RYAN_MD.slice(0, RYAN_MD.indexOf('## GROWTH LOG'))],
    ['SYSTEM_PROMPT', SYSTEM_PROMPT],
    ['generate_report', JSON.stringify(GENERATE_REPORT_TOOL)],
    ['generate_report_section', JSON.stringify(GENERATE_REPORT_SECTION_TOOL)],
  ]
  for (const [where, text] of texts) {
    for (const [id, code, name] of REMOVED) {
      assert.ok(!text.includes(name), `${where} names ${name}`)
      assert.ok(!new RegExp(`\\b${code}\\b`).test(text), `${where} names ${code}`)
      assert.ok(!text.includes(`"${id}"`), `${where} names "${id}"`)
    }
    assert.doesNotMatch(text, /\bunlocked\b|\blocked\b|on the roadmap/i, where)
  }
})

test("the + button's sheet lists the catalog, with no discipline tabs for templates that are gone", () => {
  const sheet = src('components/ReportPickerSheet.tsx')
  assert.match(sheet, /REPORT_TEMPLATES/)
  assert.doesNotMatch(sheet, /DISC_ORDER|DISCIPLINE_NAMES\[/)
  assert.doesNotMatch(sheet, /COMING WHEN|🔒/)
})
