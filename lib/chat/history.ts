import { storedReplyForModel } from './storedReply'
import { FOOTER_CARD_REPLIES } from './shownFooter'

// Brief 41 (H3) — Drift's memory: the NEWEST HISTORY_LIMIT messages of a chat
// session, oldest first. It used to load the OLDEST 30, so after about 15
// exchanges (voice gets there fast) Drift stopped seeing recent turns, and a
// calendar proposal from early on stayed "the last assistant message" forever.
export const HISTORY_LIMIT = 30

// Prisma findMany args: newest first (id breaks a same-millisecond tie).
// Brief 43 PR 16 (Q43; X-07): one row past the window, so historyWindow knows
// whether older messages were left out.
export function recentHistoryQuery(sessionId: string) {
  return {
    where: { sessionId },
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    take: HISTORY_LIMIT + 1,
  }
}

// The query returns newest first; the conversation reads oldest first.
export function oldestFirst<T>(newestFirst: readonly T[]): T[] {
  return [...newestFirst].reverse()
}

// Brief 43 PR 16 (Q43): the newest HISTORY_LIMIT messages, oldest first, and
// whether the chat has older ones the window left out.
export function historyWindow<T>(newestFirst: readonly T[]): { history: T[]; earlierNotShown: boolean } {
  return { history: oldestFirst(newestFirst.slice(0, HISTORY_LIMIT)), earlierNotShown: newestFirst.length > HISTORY_LIMIT }
}

// The model's conversation must start with a user turn. Messages are stored in
// user/Drift pairs, but a "+" report (or a reply that failed to save) leaves a
// lone Drift message, so the newest-30 window can start on one. Rather than
// drop it (a "+" report opens its chat, and follow-ups ask about it), put a
// placeholder user turn in front.
export const EARLIER_IN_CHAT = '(earlier in this chat)'
export function startAtUserTurn<T extends { role: string; content: string }>(
  messages: readonly T[],
): Array<T | { role: 'user'; content: string }> {
  return messages[0]?.role === 'assistant' ? [{ role: 'user', content: EARLIER_IN_CHAT }, ...messages] : [...messages]
}

// Brief 43 PR 8 (Q14; X-01, N13): the conversation the model gets. Drift's
// stored replies go as their text, draft and Shown note (the cards Ryan saw, in
// order, and the buyer and report), never as the stored JSON. Only the newest
// FOOTER_CARD_REPLIES replies list their cards, to keep the tokens per turn
// down; older ones keep their buyer, report and summary [engineering precaution].
//
// Brief 43 PR 16 (Q43; X-07): when the window left older messages out
// (earlierNotShown, from historyWindow), the first turn starts with
// EARLIER_NOT_SHOWN, so Drift doesn't take turn 1 of the window for the start
// of the chat. After about 15 exchanges the start used to drop out silently.
export const EARLIER_NOT_SHOWN = '(earlier messages not shown)'
export function historyForModel(
  messages: ReadonlyArray<{ role: string; content: string }>,
  opts: { earlierNotShown?: boolean } = {},
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const turns = startAtUserTurn(messages)
  let newer = turns.filter(m => m.role === 'assistant').length // replies after this one, once decremented
  const out = turns.map(m => m.role === 'assistant'
    ? { role: 'assistant' as const, content: storedReplyForModel(m.content, { withCards: --newer < FOOTER_CARD_REPLIES }) }
    : { role: 'user' as const, content: m.content })
  if (opts.earlierNotShown && out.length > 0) {
    // The placeholder turn becomes the marker; a real first turn gets it in front.
    out[0] = { role: 'user', content: messages[0].role === 'assistant' ? EARLIER_NOT_SHOWN : `${EARLIER_NOT_SHOWN}\n\n${out[0].content}` }
  }
  return out
}
