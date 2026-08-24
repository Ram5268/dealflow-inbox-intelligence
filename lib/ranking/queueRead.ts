// Brief 33 — read the latest persisted call queue for display. Shared by the
// GET /api/queue/today endpoint and the /queue server-component page. Exposes
// ONLY display fields (no internal contributions / match-id maps).
import { prisma } from '../prisma'

export interface QueueViewEntry {
  rank: number
  priorityScore: number
  reason: string
  contact: { id: string; fullName: string; phone: string | null; neighborhood: string | null }
  primaryMatch: { matchFit: number; captureStatus: string; matchFitConfidence: string } | null
}

export interface QueueView {
  generatedAt: string | null
  generationRunId: string | null
  entries: QueueViewEntry[]
}

function firstReachable(phone: string | null, additional: string[], dnc: boolean[]): string | null {
  const all = [phone, ...additional]
  for (let i = 0; i < all.length; i++) if (all[i] && !(dnc[i] ?? false)) return all[i]
  return phone
}

export async function getTodayQueue(orgId: string, limit = 50): Promise<QueueView> {
  const latest = await prisma.callQueueEntry.findFirst({
    where: { organizationId: orgId },
    orderBy: { generatedAt: 'desc' },
    select: { generationRunId: true, generatedAt: true },
  })
  if (!latest) return { generatedAt: null, generationRunId: null, entries: [] }

  const rows = await prisma.callQueueEntry.findMany({
    where: { organizationId: orgId, generationRunId: latest.generationRunId },
    orderBy: { rank: 'asc' },
    take: limit,
    select: {
      rank: true, priorityScore: true, reason: true, primaryMatchId: true,
      contact: {
        select: { id: true, fullName: true, phone: true, additionalPhones: true, phoneDncFlags: true, neighborhood: true },
      },
    },
  })

  const matchIds = rows.map(r => r.primaryMatchId).filter((id): id is string => id != null)
  const matches = matchIds.length
    ? await prisma.match.findMany({ where: { id: { in: matchIds } }, select: { id: true, score: true, captureStatus: true, matchFitConfidence: true } })
    : []
  const mMap = new Map(matches.map(m => [m.id, m]))

  const entries: QueueViewEntry[] = rows.map(r => {
    const m = r.primaryMatchId ? mMap.get(r.primaryMatchId) : undefined
    return {
      rank: r.rank,
      priorityScore: r.priorityScore,
      reason: r.reason,
      contact: {
        id: r.contact.id,
        fullName: r.contact.fullName,
        phone: firstReachable(r.contact.phone, r.contact.additionalPhones, r.contact.phoneDncFlags),
        neighborhood: r.contact.neighborhood,
      },
      primaryMatch: m ? { matchFit: m.score, captureStatus: m.captureStatus ?? 'EXTERNAL_BOTH', matchFitConfidence: m.matchFitConfidence ?? 'MEDIUM' } : null,
    }
  })

  return { generatedAt: latest.generatedAt.toISOString(), generationRunId: latest.generationRunId, entries }
}
