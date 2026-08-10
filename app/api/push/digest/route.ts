export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { sendPushToOrg } from '@/lib/push/send'
import { formatPriceRange } from '@/lib/utils'

// Brief 7.4 (A.1) — morning digest. Triggered by external cron (daily 8am ET =
// 12:00 UTC during EDT). Deployment-agnostic: prod DB is on Railway, so this is
// written to be hit by ANY external scheduler — vercel.json cron (default,
// committed) OR a Railway cron job pointing at the same URL. Protected by
// CRON_SECRET when set (Vercel cron sends `Authorization: Bearer <CRON_SECRET>`).
//
// For each org with ≥1 push subscription: find today's un-dismissed matches, pick
// the best (top HOT, else top-scored), and push a one-line digest. Zero matches →
// a lighter "quiet morning" nudge. Every send is logged (action: PUSH_SENT).

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return true // no secret configured (local/dev) — allow
  const auth = req.headers.get('authorization')
  if (auth === `Bearer ${secret}`) return true
  if (req.nextUrl.searchParams.get('secret') === secret) return true
  return false
}

function startOfTodayUtc(): Date {
  const n = new Date()
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()))
}

interface DigestResult { organizationId: string; sent: boolean; delivered: number; reason?: string }

async function buildAndSend(organizationId: string): Promise<DigestResult> {
  const prefs = await prisma.notificationPreferences.findUnique({
    where: { organizationId }, select: { digestEnabled: true },
  })
  if (prefs && !prefs.digestEnabled) return { organizationId, sent: false, delivered: 0, reason: 'digest disabled' }

  // Today's un-dismissed matches. MatchDismissal keys on (partyId, listingId) =
  // (counterpartId, opportunityId) — mirror /api/matches and exclude in code.
  const since = startOfTodayUtc()
  const todays = await prisma.match.findMany({
    where: { organizationId, createdAt: { gte: since }, counterpartType: { not: 'showing_confirmation' } },
    orderBy: [{ tier: 'asc' }, { score: 'desc' }],  // tier asc puts HOT first (enum order HOT<WARM<POSSIBLE)
    include: {
      opportunity: { select: { address: true, neighborhood: true, extractedTitle: true, price: true, minPrice: true, maxPrice: true } },
    },
  })

  let matches = todays
  if (todays.length > 0) {
    const dismissals = await prisma.matchDismissal.findMany({
      where: { OR: todays.map(m => ({ partyId: m.counterpartId, listingId: m.opportunityId })) },
      select: { partyId: true, listingId: true },
    })
    const dismissed = new Set(dismissals.map(d => `${d.partyId}::${d.listingId}`))
    matches = todays.filter(m => !dismissed.has(`${m.counterpartId}::${m.opportunityId}`))
  }

  if (matches.length === 0) {
    const lastSync = await prisma.auditLog.findFirst({
      where: { organizationId, action: 'BACKGROUND_SYNC' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true },
    })
    const ago = lastSync ? timeAgoShort(lastSync.createdAt) : 'recently'
    const delivered = await sendPushToOrg(organizationId, {
      title: 'Quiet morning',
      body:  `0 new matches. Inbox synced ${ago}.`,
      url:   '/matches',
    })
    await logSend(organizationId, delivered, 0)
    return { organizationId, sent: delivered > 0, delivered, reason: 'quiet' }
  }

  // Best match: list is already ordered HOT-first then score desc.
  const top = matches[0]
  const hot = matches.filter(m => m.tier === 'HOT' || m.score >= 90).length
  const warm = matches.filter(m => m.tier === 'WARM' || (m.score >= 70 && m.score < 90)).length
  const possible = matches.length - hot - warm

  const partyName = await counterpartName(top.counterpartType, top.counterpartId)
  const opp = top.opportunity
  const priceBit = formatPriceRange(opp.minPrice, opp.maxPrice, opp.price)
  const listingLabel = [opp.address ?? opp.extractedTitle, priceBit, opp.neighborhood].filter(Boolean).join(' ').trim()
  const extras: string[] = []
  if (warm > 0) extras.push(`${warm} Warm`)
  if (possible > 0) extras.push(`${possible} Possible`)
  const tail = extras.length ? ` Plus ${extras.join(', ')}.` : ''

  const delivered = await sendPushToOrg(organizationId, {
    title: '🔴 Your best match today',
    body:  `${partyName ? partyName + ' ↔ ' : ''}${listingLabel}.${tail}`.trim(),
    url:   `/matches?m=${top.id}`,
  })
  await logSend(organizationId, delivered, matches.length)
  return { organizationId, sent: delivered > 0, delivered }
}

async function logSend(organizationId: string, delivered: number, matchCount: number) {
  await prisma.auditLog.create({
    data: {
      organizationId,
      action: 'PUSH_SENT',
      detailsJson: { kind: 'digest', delivered, matchCount, at: new Date().toISOString() },
    },
  }).catch(() => {})
}

function timeAgoShort(d: Date): string {
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

async function counterpartName(counterpartType: string, counterpartId: string): Promise<string | null> {
  if (counterpartType === 'mojo') {
    const c = await prisma.mojoContact.findUnique({ where: { id: counterpartId }, select: { fullName: true } })
    return c?.fullName ?? null
  }
  if (counterpartType === 'opportunity') {
    const c = await prisma.extractedOpportunity.findUnique({ where: { id: counterpartId }, select: { sourceAgentName: true, extractedTitle: true } })
    return c ? (c.sourceAgentName ?? c.extractedTitle) : null
  }
  return null
}

async function run(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  // Every org that has at least one push subscription.
  const orgs = await prisma.pushSubscription.findMany({ select: { organizationId: true }, distinct: ['organizationId'] })
  const results: DigestResult[] = []
  for (const { organizationId } of orgs) {
    try { results.push(await buildAndSend(organizationId)) }
    catch (e) { results.push({ organizationId, sent: false, delivered: 0, reason: (e as Error).message }) }
  }
  return NextResponse.json({ ok: true, orgs: results.length, results })
}

export async function GET(req: NextRequest)  { return run(req) }
export async function POST(req: NextRequest) { return run(req) }
