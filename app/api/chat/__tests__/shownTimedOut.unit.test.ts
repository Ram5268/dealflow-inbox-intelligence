// Brief 43 PR 8 (review r1, on top of PR 4): a report turn that runs out of time
// still saves the report and its chat (PR 4). Its stored reply carries the Shown
// note (buyer id, report id), so "just the near-misses for that buyer"
// (DRIFT_SCRIPT #16) keeps the same buyer. PR 4's stand-ins (harness.pr4.ts):
// in-memory Prisma, scripted AI replies, a fake clock; nothing leaves the process.
import { tables, ai, HANG, flush, resetTables, dbDelayMs } from './harness.pr4'
import { test, mock, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { anthropicTool } from '../../../../lib/__tests__/fakeAiFetch'
import { storedReplyForModel } from '../../../../lib/chat/storedReply'

const START = Date.parse('2026-10-19T15:00:00Z')
async function post(body: Record<string, unknown>) {
  const { POST } = await import('../route')
  return POST(new NextRequest('http://localhost/api/chat', { method: 'POST', body: JSON.stringify(body) }))
}
beforeEach(async () => {
  await import('../route')
  resetTables()
  ai.reset()
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START })
})
afterEach(() => mock.timers.reset())

// Brief 43 PR 9 (Q15): a report needs a buyer id that search_parties returned
// earlier in the turn, so the report turn searches for the buyer first.
const BUSHWICK_BUYER = {
  id: 'buyer-1', organizationId: 'org-test', category: 'BUYER_ISO', isDuplicate: false, processingStatus: 'active',
  extractedTitle: 'Bushwick 3-family buyer', neighborhood: 'Bushwick', neighborhoods: ['Bushwick'], isTestData: true,
}

async function withFastReport(fn: () => Promise<void>) {
  const { GENERATOR_REGISTRY } = await import('../../../../lib/reports/generators')
  const real = GENERATOR_REGISTRY['buyer-match']
  GENERATOR_REGISTRY['buyer-match'] = {
    full: async () => ({ sections: [], markdown: '# Buyer Match', sources: [], subject: 'Test buyer', matchCount: 0 }),
    section: real.section,
  }
  try { await fn() } finally { GENERATOR_REGISTRY['buyer-match'] = real }
}

for (const slowSave of [false, true]) {
  test(`a timed-out report turn keeps the buyer id and report id for the next turn (slow save: ${slowSave})`, async () => {
    await withFastReport(async () => {
      if (slowSave) dbDelayMs['report.create'] = 300
      tables.extractedOpportunity = [BUSHWICK_BUYER]
      ai.script(
        () => anthropicTool('search_parties', { query: 'Bushwick 3-family' }),
        () => { if (slowSave) mock.timers.tick(51_800); return anthropicTool('generate_report', { templateId: 'buyer-match', params: { buyerId: 'buyer-1' } }) },
        () => HANG,
      )
      const arrived = ai.arrival()
      const pending = post({ message: 'buyer match report for the bushwick 3-family buyer' })
      await arrived
      await flush()
      mock.timers.tick(52_000)
      await flush()
      for (let i = 0; i < 10; i++) { mock.timers.tick(1_000); await flush() }
      const json = await (await pending).json() as { attachedReport: { reportId: string } | null }
      assert.equal(tables.report.length, 1)
      const stored = String(tables.chatMessage.find(m => m.role === 'assistant')!.content)
      const forModel = storedReplyForModel(stored)
      assert.match(forModel, /Buyer id: buyer-1/, forModel)
      assert.ok(forModel.includes(`Report id: ${tables.report[0].id}`), forModel)
      assert.equal(json.attachedReport?.reportId, tables.report[0].id)
    })
  })
}
