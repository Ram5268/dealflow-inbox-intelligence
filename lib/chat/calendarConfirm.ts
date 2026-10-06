// Brief 8.0-lite Fix #2 — the confirmed-calendar-write side of the chat route's
// two-step gate (LLM proposes a pendingEvent → user confirms → this runs). The
// confirm-word regex + pendingEvent detection stay inline in app/api/chat/route.ts;
// only these side effects live here so they can be (a) guarded by matching test
// mode and (b) unit-tested with injected fakes — the repo has no route-test
// harness, and a real POST /me/events is off-limits this brief (tenant-locked).
//
// Dependencies are injected so the test never touches Prisma or Graph.

export interface PendingEventInput {
  subject: string
  startISO: string
  endISO?: string | null
  location?: string | null
  notes?: string | null
}

export interface ConfirmDeps {
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
// AuditLog. In test mode it skips the Graph write entirely (no event, no audit
// row) but STILL persists the user + assistant chat messages so the transcript
// stays honest. Throws only if the Graph write itself fails — the route catches
// that and falls through to the normal AI path (existing behavior preserved).
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

  // Real write. Throws propagate to the route's try/catch (falls through to AI).
  const created = await deps.createEvent({
    subject,
    startISO,
    endISO,
    location: pendingEvent.location ?? undefined,
    notes:    pendingEvent.notes ?? undefined,
  })

  const { day, time } = friendly(startISO)
  const text = `Done — added to your Outlook: ${subject} on ${day} at ${time}.`
  await persistMessages(text)

  await deps.createAuditLog({
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
  })

  return { text, wroteEvent: true, eventId: created.id }
}
