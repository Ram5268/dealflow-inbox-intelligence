import type { ContextFetcher } from './types'
import { prisma } from '@/lib/prisma'
import { plainFitReason } from '@/lib/matching/fitReason'
import { getCurrentOrgId } from '@/lib/auth/orgContext'

// Triggered by the 'match' keyword in the query. Read-only (Brief 41, M18): it
// used to mark up to 20 unseen matches seen=true BEFORE the LLM ran (even when
// the turn failed, and on every chip that mentions matches), so /matches and
// the greeting silently lost matches Ryan never saw. Seen is set where Ryan
// actually views a match.
export const matchesFetcher: ContextFetcher = async ({ queryText }) => {
  const isMatchQuery = queryText.includes('match')
  if (!isMatchQuery) return { block: null }

  // Brief 32 — the surfaced lines below only read reason/score/counterpartType, so
  // the supply side no longer needs hydrating here (the dropped opportunity include
  // was already unused). Select opportunityId/opportunityType for shape parity.
  // Brief 48 PR 13 (Q44): Ryan's organization only (the seller note is scoped
  // too, Brief 43 PR 5) [engineering precaution].
  const where = { organizationId: await getCurrentOrgId(), seen: false, score: { gte: 50 } }
  const unseenMatches = await prisma.match.findMany({
    where,
    orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
    take: 20,
    select: {
      id: true, reason: true, score: true, counterpartType: true,
      opportunityId: true, opportunityType: true,
    },
  })

  if (unseenMatches.length === 0) return { block: null }
  // Brief 43 PR 6 (Q26): the header gives the true number these 20 come from
  // (it said "(20 total)"), so "how many matches?" isn't answered as 20.
  const unseenTotal = await prisma.match.count({ where })

  // Brief 41 (H7): the plain, safe reason (older rows hold raw scorer keys).
  const lines = unseenMatches.map(m =>
    m.counterpartType === 'showing_confirmation'
      ? `[SHOWING] ${m.reason}`
      : `[MATCH score:${m.score}] ${plainFitReason(m.reason, { homeowner: m.opportunityType === 'contact' || m.counterpartType === 'mojo' })}`
  )
  const shown = unseenMatches.length < unseenTotal
    ? `the ${unseenMatches.length} best-scoring of ${unseenTotal.toLocaleString('en-US')} unseen`
    : `all ${unseenTotal.toLocaleString('en-US')} unseen`
  const block = `\n\nNEW MATCHES FROM LAST SYNC (${shown}; count_matches has the exact counts by tier):\n` + lines.join('\n')

  return { block }
}
