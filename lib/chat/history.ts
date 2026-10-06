// Brief 41 (H3) — Drift's memory: the NEWEST HISTORY_LIMIT messages of a chat
// session, oldest first. It used to load the OLDEST 30, so after about 15
// exchanges (voice gets there fast) Drift stopped seeing recent turns, and a
// calendar proposal from early on stayed "the last assistant message" forever.
export const HISTORY_LIMIT = 30

// Prisma findMany args: newest first (id breaks a same-millisecond tie).
export function recentHistoryQuery(sessionId: string) {
  return {
    where: { sessionId },
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    take: HISTORY_LIMIT,
  }
}

// The query returns newest first; the conversation reads oldest first.
export function oldestFirst<T>(newestFirst: readonly T[]): T[] {
  return [...newestFirst].reverse()
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
