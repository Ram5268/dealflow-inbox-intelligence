import type { ContextFetcher } from './types'
import { prisma } from '@/lib/prisma'

// Triggered by 'match' keyword in the query OR explicit showMatches override from request body
// (e.g., when user taps "See them →" from the check-in page).
// Side effect: marks the surfaced matches as seen=true after rendering, so they don't
// re-appear on the next request. Preserved verbatim from pre-PR5 inline behavior.
export const matchesFetcher: ContextFetcher = async ({ queryText, showMatches }) => {
  const isMatchQuery = queryText.includes('match') || showMatches
  if (!isMatchQuery) return { block: null }

  const unseenMatches = await prisma.match.findMany({
    where: { seen: false, score: { gte: 50 } },
    orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
    take: 20,
    include: {
      opportunity: { select: { extractedTitle: true, category: true, neighborhood: true, price: true } },
    },
  })

  if (unseenMatches.length === 0) return { block: null }

  const lines = unseenMatches.map(m =>
    m.counterpartType === 'showing_confirmation'
      ? `[SHOWING] ${m.reason}`
      : `[MATCH score:${m.score}] ${m.reason}`
  )
  const block = `\n\nNEW MATCHES FROM LAST SYNC (${unseenMatches.length} total):\n` + lines.join('\n')

  // Mark as seen so we don't re-surface them next time
  await prisma.match.updateMany({
    where: { id: { in: unseenMatches.map(m => m.id) } },
    data:  { seen: true },
  })

  return { block }
}
