// Brief 36 — one voice turn against /api/chat (unit-tested). The session id
// lives in a ref, so a session opened by the first turn of a fresh chat is
// reused by every later turn. The old voice mode captured it in a closure and
// opened a new ChatSession per turn, losing the conversation.

export interface SessionRef {
  current: string | null
}

export type TurnResult =
  | { ok: true; text: string; interactionId: string | null }
  | { ok: false; error: string }

export const CHAT_FAILED = 'Drift couldn’t answer that. Try again.'
export const CHAT_OFFLINE = 'Connection problem. Try again.'

export async function sendVoiceTurn(message: string, session: SessionRef, fetchImpl: typeof fetch = fetch): Promise<TurnResult> {
  let res: Response
  try {
    res = await fetchImpl('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sessionId: session.current, voice: true }),
    })
  } catch {
    return { ok: false, error: CHAT_OFFLINE }
  }
  const data = await res.json().catch(() => ({}))
  // Brief 43 PR 17 [engineering precaution]: a spending-limit refusal says
  // what to do ("It resets at midnight"), so show its words, not "Try again".
  if (res.status === 429 && data.error === 'spend_limit' && typeof data.message === 'string') return { ok: false, error: data.message }
  if (typeof data.sessionId === 'string') session.current = data.sessionId
  const text = typeof data.response === 'string' ? data.response.trim() : ''
  // Never speak an error (the route's 500 body carries "Server error: …").
  if (!res.ok || data.error || !text || text.startsWith('Server error:')) return { ok: false, error: CHAT_FAILED }
  return { ok: true, text, interactionId: typeof data.interactionId === 'string' ? data.interactionId : null }
}
