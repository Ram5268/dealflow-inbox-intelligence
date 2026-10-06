import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runCalendarConfirm, type ConfirmDeps } from '../calendarConfirm'

// Run: `npm test` (ts-node via node:test). Injected fakes — never touches Prisma
// or Microsoft Graph (POST /me/events is off-limits this brief).
//
// Brief 8.0-lite Fix #2. runCalendarConfirm is the confirmed-write side of the
// chat two-step gate. Asserts: test mode skips Graph but still logs the chat with
// no CALENDAR_WRITE audit row; test mode off creates the event and writes the
// audit row with source 'chat-confirm'.

interface Recorder {
  events: Array<Record<string, unknown>>
  messages: Array<Record<string, unknown>>
  audits: Array<Record<string, unknown>>
  touched: string[]
}

function makeDeps(testModeOn: boolean, graphOn = true): { deps: ConfirmDeps; rec: Recorder } {
  const rec: Recorder = { events: [], messages: [], audits: [], touched: [] }
  const deps: ConfirmDeps = {
    graphOn,
    testModeOn,
    createEvent: async (input) => { rec.events.push(input); return { id: 'evt_123', webLink: null } },
    createMessage: async (data) => { rec.messages.push(data); return data },
    createAuditLog: async (data) => { rec.audits.push(data); return data },
    touchSession: async (id) => { rec.touched.push(id); return null },
  }
  return { deps, rec }
}

const BASE = {
  organizationId: 'org-1',
  sessionId: 'sess-1',
  userMessage: 'yes confirm',
  pendingEvent: {
    subject: 'Showing: 123 Main St',
    startISO: '2026-08-20T14:00:00',
    endISO: '2026-08-20T14:30:00',
    location: '123 Main St',
    notes: 'party notes',
  },
}

test('test mode ON → skips Graph, writes both chat messages, NO audit row', async () => {
  const { deps, rec } = makeDeps(true)
  const result = await runCalendarConfirm({ ...BASE, deps })

  assert.equal(rec.events.length, 0, 'createEvent must not be called in test mode')
  assert.equal(result.wroteEvent, false)
  assert.equal(result.eventId, null)
  assert.match(result.text, /disabled in test mode/i)

  // Both chat rows still persisted + session touched.
  assert.equal(rec.messages.length, 2)
  assert.equal(rec.messages[0].role, 'user')
  assert.equal(rec.messages[1].role, 'assistant')
  assert.equal(rec.touched[0], 'sess-1')

  // No CALENDAR_WRITE audit row in test mode.
  assert.equal(rec.audits.length, 0)
})

test('test mode OFF → creates event + writes CALENDAR_WRITE audit (source chat-confirm)', async () => {
  const { deps, rec } = makeDeps(false)
  const result = await runCalendarConfirm({ ...BASE, deps })

  assert.equal(rec.events.length, 1, 'createEvent called exactly once')
  assert.equal(rec.events[0].subject, 'Showing: 123 Main St')
  assert.equal(rec.events[0].endISO, '2026-08-20T14:30:00')
  assert.equal(result.wroteEvent, true)
  assert.equal(result.eventId, 'evt_123')
  assert.match(result.text, /Done — added/i)

  assert.equal(rec.messages.length, 2)

  // Exactly one audit row with the required shape.
  assert.equal(rec.audits.length, 1)
  const audit = rec.audits[0]
  assert.equal(audit.action, 'CALENDAR_WRITE')
  assert.equal(audit.organizationId, 'org-1')
  const details = audit.detailsJson as Record<string, unknown>
  assert.equal(details.source, 'chat-confirm')
  assert.equal(details.sessionId, 'sess-1')
  assert.equal(details.eventId, 'evt_123')
  assert.equal(details.subject, 'Showing: 123 Main St')
  assert.equal(details.userMessage, 'yes confirm')
  assert.ok(typeof details.at === 'string')
})

test('missing endISO → defaults to 30 min after start', async () => {
  const { deps, rec } = makeDeps(false)
  await runCalendarConfirm({
    ...BASE,
    pendingEvent: { subject: 'X', startISO: '2026-08-20T14:00:00.000Z', endISO: null },
    deps,
  })
  assert.equal(rec.events[0].endISO, '2026-08-20T14:30:00.000Z')
})

// Brief 41 (H10): with Outlook paused (GRAPH_ENABLED not 'true') nothing is
// written to Graph and the reply says so plainly — never a false "Done".
test('Outlook paused: no event, no CALENDAR_WRITE audit, honest reply, chat still logged', async () => {
  for (const testModeOn of [false, true]) {
    const { deps, rec } = makeDeps(testModeOn, false)
    const r = await runCalendarConfirm({ ...BASE, deps })
    assert.equal(r.wroteEvent, false)
    assert.equal(r.eventId, null)
    assert.match(r.text, /Outlook is paused/)
    assert.doesNotMatch(r.text, /Done|added to your Outlook/)
    assert.equal(rec.events.length, 0)
    assert.equal(rec.audits.length, 0)
    assert.equal(rec.messages.length, 2)
  }
})
