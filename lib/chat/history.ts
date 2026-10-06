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
