// Brief 43 PR 14: the per-turn calendar block. On every turn Drift gets today's
// date in New York (so "today", "this week" and "Thursday at 3" mean something),
// and while Outlook is paused [Ryan, 2026-09-24] it is told that email reading
// is paused too, with the date of the newest email on file (Q29, M21), and what
// to say about the calendar (D8, a Brief 42 default). The proposal lines
// (pendingEvent) go in only while Outlook is on (Q33). A fake Prisma answers
// the one read; no database, no network, no Microsoft Graph.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { todayLine } from '../today'
import { graphPausedEmailBlock, GRAPH_PAUSED_CALENDAR_BLOCK, GRAPH_ON_CALENDAR_NOTE } from '../../../graphAccess'
import type { ParsedQuery } from '../../../retrieval/types'

let newestEmail: Date | null | 'throw' = null
const reads: unknown[] = []
;(globalThis as unknown as { prisma: unknown }).prisma = {
  rawEmail: {
    findFirst: async (args: unknown) => {
      reads.push(args)
      if (newestEmail === 'throw') throw new Error('db down')
      return newestEmail ? { receivedDateTime: newestEmail } : null
    },
  },
}
globalThis.fetch = (async (u: unknown) => { throw new Error(`test: unexpected network call to ${String(u).split('?')[0]}`) }) as typeof fetch

const parsed = { isCalendar: false } as ParsedQuery
const input = { parsed, userMessage: 'what came in today?', queryText: 'what came in today?', isConfirmMessage: false }

test('todayLine: the date and the part of the day, in New York', () => {
  assert.equal(todayLine(new Date('2026-10-19T13:05:00Z')), '\n\nTODAY: Monday, October 19, 2026, 9:05 AM in New York (morning).')
  assert.equal(todayLine(new Date('2026-10-19T21:40:00Z')), '\n\nTODAY: Monday, October 19, 2026, 5:40 PM in New York (evening).')
  // Just after midnight UTC is still the evening before in New York.
  assert.equal(todayLine(new Date('2026-10-20T01:30:00Z')), '\n\nTODAY: Monday, October 19, 2026, 9:30 PM in New York (evening).')
  assert.equal(todayLine(new Date('2026-10-19T17:00:00Z')), '\n\nTODAY: Monday, October 19, 2026, 1:00 PM in New York (afternoon).')
})

test('graphPausedEmailBlock: email reading is paused, with the newest email date', () => {
  const b = graphPausedEmailBlock(new Date('2026-06-27T15:00:00Z'))
  assert.match(b, /^\n\nEMAIL: Email reading is paused/)
  assert.match(b, /June 27, 2026/)
  assert.ok(b.includes('"Email reading is paused, so nothing new has come in since June 27."'), b)
  // No email on file at all: no date, still paused.
  const none = graphPausedEmailBlock(null)
  assert.match(none, /Email reading is paused/)
  assert.doesNotMatch(none, /since/)
  for (const s of [b, none]) assert.ok(!s.includes('—') && !s.includes('!'))
})

test('Outlook paused: today, the calendar note (D8) and the email note, every turn', async () => {
  delete process.env.GRAPH_ENABLED
  newestEmail = new Date('2026-06-27T15:00:00Z')
  reads.length = 0
  const { calendarFetcher } = await import('../calendar')
  const { block } = await calendarFetcher(input)
  assert.ok(block)
  assert.match(block, /^\n\nTODAY: /)
  assert.ok(block.includes(GRAPH_PAUSED_CALENDAR_BLOCK), 'the D8 calendar note')
  assert.ok(block.includes(graphPausedEmailBlock(newestEmail)), 'the email-paused note')
  assert.ok(!block.includes('pendingEvent'))
  assert.equal(reads.length, 1)
  assert.deepEqual(reads[0], { orderBy: { receivedDateTime: 'desc' }, select: { receivedDateTime: true } })
})

test('Outlook paused and the read fails: still paused, just without the date', async () => {
  delete process.env.GRAPH_ENABLED
  newestEmail = 'throw'
  const { calendarFetcher } = await import('../calendar')
  const { block } = await calendarFetcher(input)
  assert.ok(block?.includes(GRAPH_PAUSED_CALENDAR_BLOCK))
  assert.ok(block?.includes(graphPausedEmailBlock(null)))
})

test('Outlook on: today and the proposal lines, no paused notes, no email read', async () => {
  process.env.GRAPH_ENABLED = 'true'
  try {
    reads.length = 0
    const { calendarFetcher } = await import('../calendar')
    const { block } = await calendarFetcher(input)
    assert.ok(block)
    assert.match(block, /^\n\nTODAY: /)
    assert.ok(block.includes(GRAPH_ON_CALENDAR_NOTE))
    assert.ok(!block.includes('Outlook is paused'))
    assert.ok(!block.includes('Email reading is paused'))
    assert.equal(reads.length, 0)
  } finally {
    delete process.env.GRAPH_ENABLED
  }
})
