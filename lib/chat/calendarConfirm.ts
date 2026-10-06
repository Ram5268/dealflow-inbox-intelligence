// Brief 8.0-lite Fix #2 — the confirmed-calendar-write side of the chat route's
// two-step gate (LLM proposes a pendingEvent → user confirms → this runs). The
// plain-yes check (isCalendarConfirm, below) and the pendingEvent detection run
// in app/api/chat/route.ts; the side effects live here so they can be (a) guarded
// by matching test mode and (b) unit-tested with injected fakes — the repo has no
// route-test harness, and a real POST /me/events is off-limits this brief.
//
// Dependencies are injected so the test never touches Prisma or Graph.

// Brief 41 (M17): the reply when a calendar write fails. Never a false "booked".
export const CALENDAR_CONFIRM_FAILED = "I couldn't add that to your calendar, so nothing was booked."

// Brief 41 (M17): only a short, plain yes confirms a proposed event. The old
// check matched these words ANYWHERE in the message, so "no, don't add it" and
// "yes but make it 4pm" booked the original event. Optional: a leading "ok" /
// "yes"-type word and a trailing "please" / "thanks"; case and punctuation
// don't matter. Everything else goes to Drift as a normal message.
const CONFIRM_PHRASES = new Set([
  'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'confirm', 'confirmed',
  'do it', 'go ahead', 'go for it', 'add it', 'book it', 'please do', 'please add it',
  'go ahead and add it', 'go ahead and book it', 'looks good', 'sounds good',
])
const LEAD_INS = new Set(['yes', 'yeah', 'yep', 'ok', 'okay', 'sure'])
const POLITE_TAIL = /\s+(please|thanks|thank you)$/
const FILLERS = /^((uh|um|er|hmm)\s+)+/ // voice transcripts: "Um, yes."
const TO_CALENDAR = /\s+to (my|the) (calendar|outlook)$/

export function isCalendarConfirm(message: string): boolean {
  if (message.trim().endsWith('?')) return false // "Yes?" asks, it doesn't confirm
  let t = message.toLowerCase().replace(/[.,!;:'"’“”…]/g, ' ').replace(/\s+/g, ' ').trim()
  t = t.replace(FILLERS, '').replace(POLITE_TAIL, '').replace(TO_CALENDAR, '').trim()
  if (CONFIRM_PHRASES.has(t)) return true
  const space = t.indexOf(' ')
  return space > 0 && LEAD_INS.has(t.slice(0, space)) && CONFIRM_PHRASES.has(t.slice(space + 1))
}

export interface PendingEventInput {
  subject: string
  startISO: string
  endISO?: string | null
  location?: string | null
  notes?: string | null
}

export interface ConfirmDeps {
  // Brief 41: was this exact event already written in this session? (A reply
  // that failed to save leaves the proposal as the last message, so a second
  // "yes" must not book it twice.) Optional for older callers.
  alreadyWritten?: (sessionId: string, event: { subject: string; startISO: string }) => Promise<boolean>
  // False unless GRAPH_ENABLED is exactly 'true' (Outlook is paused, Brief 41):
  // skip the write and say so, still log the chat.
  graphOn: boolean
  // True when MATCHING_TEST_MODE_ONLY is on — skip the real write, still log the chat.
  testModeOn: boolean
  createEvent: (input: {
    subject: string; startISO: string; endISO: string
    location?: string; notes?: string
  }) => Promise<{ id: string; webLink: string | null }>
  createMessage: (data: {
    organizationId: string; sessionId: string
    role: 'user' | 'assistant'; content: string
    dealsJson?: unknown; suggestions?: unknown
  }) => Promise<unknown>
  createAuditLog: (data: {
    organizationId: string; action: string; detailsJson: unknown
  }) => Promise<unknown>
  touchSession: (sessionId: string) => Promise<unknown>
}

export interface ConfirmResult {
  text: string
  wroteEvent: boolean
  eventId: string | null
  error?: string // set when the calendar write failed (nothing was booked)
}

// Default end = 30 min after start when the proposal didn't carry one.
function resolveEndISO(startISO: string, endISO?: string | null): string {
  if (endISO) return endISO
  const d = new Date(startISO)
  d.setMinutes(d.getMinutes() + 30)
  return d.toISOString()
}

function friendly(startISO: string): { day: string; time: string } {
  const d = new Date(startISO)
  return {
    day:  d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }),
    time: d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
  }
}

// Runs a user-confirmed calendar write. On success writes the CALENDAR_WRITE
// AuditLog first (Brief 41: so a later failure can't lose it), then the chat
// messages. In test mode it skips the Graph write entirely (no event, no audit
// row) but STILL persists the user + assistant chat messages so the transcript
// stays honest. If the Graph write fails it says so plainly (Brief 41: the route
// used to fall through to the AI, which could claim the event was booked).
export async function runCalendarConfirm(args: {
  organizationId: string
  sessionId: string
  userMessage: string
  pendingEvent: PendingEventInput
  deps: ConfirmDeps
}): Promise<ConfirmResult> {
  const { organizationId, sessionId, userMessage, pendingEvent, deps } = args
  const { subject, startISO } = pendingEvent
  const endISO = resolveEndISO(startISO, pendingEvent.endISO)

  const persistMessages = async (assistantText: string) => {
    await deps.createMessage({ organizationId, sessionId, role: 'user', content: userMessage })
    await deps.createMessage({
      organizationId, sessionId, role: 'assistant',
      content: assistantText, dealsJson: [], suggestions: [],
    })
    await deps.touchSession(sessionId)
  }

  // Outlook is paused: nothing is written, and the reply says so plainly.
  if (!deps.graphOn) {
    const text = "Outlook is paused, so I didn't add that to your calendar."
    await persistMessages(text)
    return { text, wroteEvent: false, eventId: null }
  }

  // Safety gate — no real M365 write while the matcher is in test-mode isolation.
  if (deps.testModeOn) {
    const text = 'Calendar writes are disabled in test mode.'
    await persistMessages(text)
    return { text, wroteEvent: false, eventId: null }
  }

  if (deps.alreadyWritten && (await deps.alreadyWritten(sessionId, { subject, startISO }))) {
    const text = "That's already on your calendar."
    try { await persistMessages(text) } catch (err) { console.error('[DealFlow] Calendar confirm: saving the chat failed:', err) }
    return { text, wroteEvent: false, eventId: null }
  }

  let created: { id: string; webLink: string | null }
  try {
    created = await deps.createEvent({
      subject,
      startISO,
      endISO,
      location: pendingEvent.location ?? undefined,
      notes:    pendingEvent.notes ?? undefined,
    })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('[DealFlow] Calendar confirm: the calendar write failed:', error)
    await persistMessages(CALENDAR_CONFIRM_FAILED)
    return { text: CALENDAR_CONFIRM_FAILED, wroteEvent: false, eventId: null, error }
  }

  const { day, time } = friendly(startISO)
  const text = `Done — added to your Outlook: ${subject} on ${day} at ${time}.`

  // The event exists now: record it, then the chat. A failure from here on is
  // logged but never turns into "nothing was booked" (it was).
  const afterWrite = async (step: string, run: () => Promise<unknown>) => {
    try { await run() } catch (err) { console.error(`[DealFlow] Calendar confirm: ${step} failed after the event was created:`, err) }
  }
  await afterWrite('audit log', () => deps.createAuditLog({
    organizationId,
    action: 'CALENDAR_WRITE',
    detailsJson: {
      source: 'chat-confirm',
      sessionId,
      userMessage,
      eventId: created.id,
      subject,
      startISO,
      endISO,
      at: new Date().toISOString(),
    },
  }))
  await afterWrite('saving the chat', () => persistMessages(text))

  return { text, wroteEvent: true, eventId: created.id }
}
