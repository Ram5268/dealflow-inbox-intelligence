import type { PrismaClient } from '@prisma/client'

// Brief 35: id-IN lookups in ≤5,000-id chunks. A per-match OR of (partyId,
// listingId) pairs blew Prisma's 32,766 bind-variable limit (P2029) once
// /matches passed ~16k rows.
export const ID_CHUNK = 5_000

export async function inChunks<T>(ids: string[], fetch: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += ID_CHUNK) out.push(...(await fetch(ids.slice(i, i + ID_CHUNK))))
  return out
}

type Pair = { opportunityId: string; counterpartId: string }

// Returns a predicate telling whether a match's pair was dismissed. A dismissal
// names two ids, so either orientation counts (legacy rows put the buyer on
// either side).
export async function loadDismissedPairs(db: Pick<PrismaClient, 'matchDismissal'>, matches: Pair[]) {
  const ids = [...new Set(matches.flatMap(m => [m.opportunityId, m.counterpartId]))]
  const rows = await inChunks(ids, chunk =>
    db.matchDismissal.findMany({ where: { listingId: { in: chunk } }, select: { partyId: true, listingId: true } }))
  const keys = new Set(rows.map(d => `${d.partyId}::${d.listingId}`))
  return (m: Pair) => keys.has(`${m.counterpartId}::${m.opportunityId}`) || keys.has(`${m.opportunityId}::${m.counterpartId}`)
}
