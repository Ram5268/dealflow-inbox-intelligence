// Brief 33 — top-level ranker. Fetches contacts + their matches, aggregates per
// contact, applies hard filters, scores via composeCallPriority, ranks, and
// (optionally) persists a CallQueueEntry snapshot. The rank UNIT is a CONTACT.
//
// Only matches involving at least one MojoContact are considered (opportunityType
// 'contact' OR counterpartType 'mojo'). EO×EO inbox pairs are excluded by the
// query — Ryan can't cold-call them (Brief 33 scope-out).
import { randomUUID } from 'crypto'
import { prisma } from '../prisma'
import type { AggregatedContact, AggregatedMatch, Confidence, RankingContext } from './types'
import { applyHardFilters } from './hardFilters'
import { composeCallPriority } from './callPriority'
import { computeMatchFitLift } from './features/matchFitLift'
import { computeMatchFitConfidenceLift } from './features/matchFitConfidenceLift'
import { computeCaptureBonus } from './features/captureBonus'
import { computeFreshnessBoost } from './features/freshnessBoost'
import { computeCooldownPenalty } from './features/cooldownPenalty'
import { computeReachabilityBonus } from './features/reachabilityBonus'
import { computeMotivationSummary } from './features/motivationSummary'

interface RawMatch {
  id: string
  matchFit: number
  matchFitConfidence: Confidence
  captureStatus: string
  createdAt: Date
  contributions: Record<string, number>
}

export interface QueueEntry {
  rank: number
  priorityScore: number
  reason: string
  contactId: string
  primaryMatchId: string | null
  contributingMatchIds: string[]
  contributions: Record<string, number>
  contact: { id: string; fullName: string; phone: string | null; neighborhood: string | null }
  primaryMatch: { matchFit: number; captureStatus: string; matchFitConfidence: Confidence } | null
}

export interface QueueStats {
  totalContactsConsidered: number
  exclusionCounts: Record<string, number>
  queueLength: number
  priorityDistribution: {
    top10Avg: number
    top50Avg: number
    rank1Score: number
    rank50Score: number
    spread: number
  }
}

const CONFIDENCES: Confidence[] = ['HIGH', 'MEDIUM', 'LOW']
function coerceConfidence(v: string | null): Confidence {
  return v && (CONFIDENCES as string[]).includes(v) ? (v as Confidence) : 'MEDIUM'
}

function firstReachablePhone(phone: string | null, additional: string[], dncFlags: boolean[]): string | null {
  const all = [phone, ...additional]
  for (let i = 0; i < all.length; i++) {
    if (all[i] && !(dncFlags[i] ?? false)) return all[i]
  }
  return phone
}

function buildReason(
  contribs: Record<string, number>,
  agg: AggregatedContact,
  ctx: RankingContext,
): string {
  const sorted = Object.entries(contribs).sort((a, b) => b[1] - a[1])
  const top = sorted[0]?.[0]
  const second = sorted[1]?.[0]
  const tm = agg.topMatch
  const fallback = `Match: ${[top, second].filter(Boolean).join(' + ')}`
  switch (top) {
    case 'matchFitLift':
      return `Top ${tm.matchFit}-scored match`
    case 'motivationSummary':
      if (agg.contact.preForeclosureStatus && agg.contact.preForeclosureStatus !== 'NONE') return 'Pre-foreclosure — high motivation'
      if (agg.contact.isVacant === true) return 'Vacant property — high motivation'
      return 'Strong seller-motivation signals'
    case 'captureBonus':
      if (tm.captureStatus === 'OWN_BOTH_SIDES') return 'Double-ended: you rep both sides'
      if (tm.captureStatus === 'OWN_LISTING_ONLY') return 'Your listing, external buyer'
      if (tm.captureStatus === 'OWN_BUYER_ONLY') return 'Your buyer, external listing'
      return fallback
    case 'freshnessBoost': {
      const days = Math.max(0, Math.round((ctx.now.getTime() - tm.createdAt.getTime()) / 86400000))
      return `Fresh ${days}-day-old match`
    }
    case 'cooldownPenalty':
      if (agg.contact.lastCalled == null && agg.contact.lastDialDate == null) return 'Never contacted'
      return fallback
    default:
      return fallback
  }
}

export async function buildCallQueue(
  orgId: string,
  limit = 50,
  persist = true,
): Promise<{ entries: QueueEntry[]; stats: QueueStats; generationRunId: string }> {
  const now = new Date()
  const ctx: RankingContext = { now }

  const contacts = await prisma.mojoContact.findMany({
    where: { organizationId: orgId },
    select: {
      id: true, fullName: true, phone: true, additionalPhones: true, phoneDncFlags: true,
      phoneTypes: true, lastCalled: true, lastDialDate: true, status: true,
      preForeclosureStatus: true, isVacant: true, neighborhood: true, tags: true, groups: true,
    },
  })

  // One query for every mojo-involving match; bucket by contact id in code.
  const matches = await prisma.match.findMany({
    where: { organizationId: orgId, OR: [{ opportunityType: 'contact' }, { counterpartType: 'mojo' }] },
    select: {
      id: true, score: true, matchFitConfidence: true, captureStatus: true, createdAt: true,
      contributions: true, opportunityId: true, opportunityType: true, counterpartId: true, counterpartType: true,
    },
  })

  const buckets = new Map<string, RawMatch[]>()
  const push = (cid: string, m: RawMatch) => {
    const arr = buckets.get(cid) ?? []
    arr.push(m)
    buckets.set(cid, arr)
  }
  for (const m of matches) {
    const rm: RawMatch = {
      id: m.id, matchFit: m.score, matchFitConfidence: coerceConfidence(m.matchFitConfidence),
      captureStatus: m.captureStatus ?? 'EXTERNAL_BOTH', createdAt: m.createdAt,
      contributions: (m.contributions as Record<string, number> | null) ?? {},
    }
    if (m.opportunityType === 'contact') push(m.opportunityId, rm)
    if (m.counterpartType === 'mojo') push(m.counterpartId, rm)
  }

  const exclusionCounts: Record<string, number> = {}
  const scored: Array<{ entry: Omit<QueueEntry, 'rank'>; priorityScore: number }> = []

  for (const c of contacts) {
    const ms = (buckets.get(c.id) ?? []).sort((a, b) => b.matchFit - a.matchFit)

    const filter = applyHardFilters({
      status: c.status, tags: c.tags, groups: c.groups,
      phones: [c.phone, ...c.additionalPhones], phoneDncFlags: c.phoneDncFlags,
      matchCount: ms.length, allMatchesRental: false, // scorer already rejects rentals
    })
    if (filter.excluded) {
      exclusionCounts[filter.reason!] = (exclusionCounts[filter.reason!] ?? 0) + 1
      continue
    }

    const top = ms[0]
    const contributing = ms.slice(0, 5)
    const agg: AggregatedContact = {
      contactId: c.id,
      contactType: 'mojoContact',
      topMatch: {
        id: top.id, matchFit: top.matchFit, matchFitConfidence: top.matchFitConfidence,
        captureStatus: top.captureStatus, createdAt: top.createdAt, contributions: top.contributions,
      },
      contributingMatches: contributing.map((m): AggregatedMatch => ({
        id: m.id, matchFit: m.matchFit, captureStatus: m.captureStatus, contributions: m.contributions,
      })),
      contact: {
        id: c.id, fullName: c.fullName, phone: c.phone, additionalPhones: c.additionalPhones,
        phoneDncFlags: c.phoneDncFlags, phoneTypes: c.phoneTypes, lastCalled: c.lastCalled,
        lastDialDate: c.lastDialDate, status: c.status, preForeclosureStatus: c.preForeclosureStatus,
        isVacant: c.isVacant, neighborhood: c.neighborhood, tags: c.tags, groups: c.groups,
      },
    }

    const features = [
      computeMatchFitLift(agg),
      computeMatchFitConfidenceLift(agg),
      computeCaptureBonus(agg),
      computeFreshnessBoost(agg, ctx),
      computeCooldownPenalty(agg, ctx),
      computeReachabilityBonus(agg),
      computeMotivationSummary(agg),
    ]
    const { priorityScore, contributions } = composeCallPriority(features)

    scored.push({
      priorityScore,
      entry: {
        priorityScore,
        reason: buildReason(contributions, agg, ctx),
        contactId: c.id,
        primaryMatchId: top.id,
        contributingMatchIds: contributing.filter(m => m.id !== top.id).map(m => m.id),
        contributions,
        contact: {
          id: c.id, fullName: c.fullName,
          phone: firstReachablePhone(c.phone, c.additionalPhones, c.phoneDncFlags),
          neighborhood: c.neighborhood,
        },
        primaryMatch: { matchFit: top.matchFit, captureStatus: top.captureStatus, matchFitConfidence: top.matchFitConfidence },
      },
    })
  }

  scored.sort((a, b) => b.priorityScore - a.priorityScore)
  const entries: QueueEntry[] = scored.slice(0, limit).map((s, i) => ({ rank: i + 1, ...s.entry }))

  const scores = entries.map(e => e.priorityScore)
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  const top10Avg = avg(scores.slice(0, 10))
  const top50Avg = avg(scores.slice(0, 50))
  const rank1Score = scores[0] ?? 0
  const rank50Score = scores.length >= 1 ? scores[Math.min(scores.length, 50) - 1] : 0

  const generationRunId = randomUUID()

  if (persist && entries.length > 0) {
    await prisma.$transaction([
      prisma.callQueueEntry.deleteMany({ where: { organizationId: orgId } }),
      prisma.callQueueEntry.createMany({
        data: entries.map(e => ({
          organizationId: orgId,
          contactId: e.contactId,
          rank: e.rank,
          priorityScore: e.priorityScore,
          reason: e.reason,
          primaryMatchId: e.primaryMatchId,
          contributingMatchIds: e.contributingMatchIds,
          contributions: e.contributions,
          generationRunId,
        })),
        skipDuplicates: true,
      }),
    ])
  }

  return {
    entries,
    generationRunId,
    stats: {
      totalContactsConsidered: contacts.length,
      exclusionCounts,
      queueLength: entries.length,
      priorityDistribution: { top10Avg, top50Avg, rank1Score, rank50Score, spread: rank1Score - rank50Score },
    },
  }
}
