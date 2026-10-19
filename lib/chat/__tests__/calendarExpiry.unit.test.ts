// Brief 43 PR 14 (F9, dormant while Outlook is paused [Ryan, 2026-09-24]): a
// calendar proposal is only good for a while. A "yes" to one whose start time
// has passed, or that is more than about a day old, books nothing and says so;
// and the paused check comes before any date maths, so an unreadable time on an
// old proposal still gets the honest "Outlook is paused" reply. Injected fakes:
// no Prisma, no Microsoft Graph, no network [engineering precaution].
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  runCalendarConfirm, proposalExpiry, PROPOSAL_MAX_AGE_MS,
  CALENDAR_CONFIRM_FAILED, CALENDAR_PROPOSAL_PASSED, CALENDAR_PROPOSAL_STALE, type ConfirmDeps,
} from '../calendarConfirm'

const NOW = Date.parse('2026-10-19T16:00:00Z')
const HOUR = 60 * 60 * 1000

function makeDeps(graphOn = true) {
  const rec = { events: 0, messages: [] as Array<Record<string, unknown>>, audits: 0 }
  const deps: ConfirmDeps = {
    graphOn,
    testModeOn: false,
    now: () => NOW,
    createEvent: async () => { rec.events++; return { id: 'evt_1', webLink: null } },
    createMessage: async (d) => { rec.messages.push(d); return d },
    createAuditLog: async (d) => { rec.audits++; return d },
    touchSession: async () => null,
  }
  return { deps, rec }
}

const event = (startISO: string) => ({ subject: 'Showing: 88 Example Ave', startISO, endISO: null })
const confirm = (deps: ConfirmDeps, startISO: string, proposedAt: Date | null) =>
  runCalendarConfirm({ organizationId: 'org-1', sessionId: 'sess-1', userMessage: 'yes', pendingEvent: event(startISO), proposedAt, deps })

test('proposalExpiry: passed start, more than a day old, unreadable, or fine', () => {
  const proposedAt = new Date(NOW - HOUR)
  assert.equal(proposalExpiry({ startISO: '2026-10-20T19:00:00Z', proposedAt, now: NOW }), null)
  assert.equal(proposalExpiry({ startISO: '2026-10-19T15:59:00Z', proposedAt, now: NOW }), 'passed')
  assert.equal(proposalExpiry({ startISO: '2026-10-19T16:00:00Z', proposedAt, now: NOW }), 'passed')
  assert.equal(proposalExpiry({ startISO: '2026-10-25T19:00:00Z', proposedAt: new Date(NOW - PROPOSAL_MAX_AGE_MS - 1), now: NOW }), 'stale')
  assert.equal(proposalExpiry({ startISO: '2026-10-25T19:00:00Z', proposedAt: new Date(NOW - PROPOSAL_MAX_AGE_MS + 60_000), now: NOW }), null)
  assert.equal(proposalExpiry({ startISO: 'next thursday', proposedAt, now: NOW }), 'invalid')
  assert.equal(proposalExpiry({ startISO: '', proposedAt, now: NOW }), 'invalid')
  // No proposal time on record (older callers): only the start time is checked.
  assert.equal(proposalExpiry({ startISO: '2026-10-20T19:00:00Z', proposedAt: null, now: NOW }), null)
  assert.equal(proposalExpiry({ startISO: '2026-10-20T19:00:00Z', proposedAt: 'not a date', now: NOW }), null)
  assert.equal(PROPOSAL_MAX_AGE_MS, 24 * HOUR)
})

test('a yes to a proposal whose time has passed books nothing and says so', async () => {
  const { deps, rec } = makeDeps()
  const r = await confirm(deps, '2026-10-19T14:00:00Z', new Date(NOW - 3 * HOUR))
  assert.equal(r.wroteEvent, false)
  assert.equal(r.text, CALENDAR_PROPOSAL_PASSED)
  assert.equal(rec.events, 0)
  assert.equal(rec.audits, 0)
  assert.equal(rec.messages.length, 2, 'the chat is still saved')
  assert.equal(rec.messages[1].content, CALENDAR_PROPOSAL_PASSED)
})

test('a yes to a proposal more than a day old books nothing and says so', async () => {
  const { deps, rec } = makeDeps()
  const r = await confirm(deps, '2026-10-23T19:00:00Z', new Date(NOW - 30 * HOUR))
  assert.equal(r.wroteEvent, false)
  assert.equal(r.text, CALENDAR_PROPOSAL_STALE)
  assert.equal(rec.events, 0)
})

test('an unreadable start time books nothing: "nothing was booked"', async () => {
  const { deps, rec } = makeDeps()
  const r = await confirm(deps, 'next thursday', new Date(NOW - HOUR))
  assert.equal(r.wroteEvent, false)
  assert.equal(r.text, CALENDAR_CONFIRM_FAILED)
  assert.equal(rec.events, 0)
})

test('a fresh proposal still books (Outlook on, test mode off)', async () => {
  const { deps, rec } = makeDeps()
  const r = await confirm(deps, '2026-10-20T19:00:00Z', new Date(NOW - HOUR))
  assert.equal(r.wroteEvent, true)
  assert.equal(rec.events, 1)
  assert.match(r.text, /^Done\. Added to your Outlook: /)
  assert.ok(!r.text.includes('—'), 'no em-dash (feel standard)')
})

test('paused comes first: an old, unreadable proposal gets the paused reply, never a throw', async () => {
  for (const startISO of ['next thursday', '', '2026-10-01T10:00:00Z']) {
    const { deps, rec } = makeDeps(false)
    const r = await confirm(deps, startISO, new Date(NOW - 40 * HOUR))
    assert.match(r.text, /Outlook is paused/, startISO)
    assert.equal(r.wroteEvent, false)
    assert.equal(rec.events, 0)
  }
})

test('stored chat rows carry no suggestions (D7)', async () => {
  const { deps, rec } = makeDeps()
  await confirm(deps, '2026-10-20T19:00:00Z', new Date(NOW - HOUR))
  for (const m of rec.messages) assert.ok(!('suggestions' in m), JSON.stringify(m))
})
